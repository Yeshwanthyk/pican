package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pican/internal/runtimes"
	"pican/internal/server"
	"pican/internal/sessions"
)

func testRuntimeRegistry(t *testing.T, ids ...runtimes.ID) *runtimeRegistry {
	t.Helper()
	registered := make([]applicationRuntime, 0, len(ids))
	for _, id := range ids {
		registered = append(registered, applicationRuntime{
			registration: runtimes.Registration{
				Descriptor: runtimes.Descriptor{
					ID:             id,
					Label:          string(id),
					Command:        string(id),
					ProjectionMode: runtimes.ProjectionAppendOnlyNative,
				},
				AvailabilityProbe: func(context.Context) runtimes.Availability {
					return runtimes.Availability{Available: true}
				},
			},
		})
	}
	registry, err := newRuntimeRegistry(registered...)
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func TestParseRuntimeAndCodexCommand(t *testing.T) {
	registry := testRuntimeRegistry(t, runtimes.PiID, runtimes.CodexID, runtimes.ClaudeID, runtimes.OpenCodeID, "future")
	tests := []struct {
		value string
		want  []string
	}{
		{"pi", []string{"pi"}},
		{"codex", []string{"codex"}},
		{"both", []string{"pi", "codex"}},
		{"claude", []string{"claude"}},
		{"opencode", []string{"opencode"}},
		{"opencode,claude,pi", []string{"pi", "claude", "opencode"}},
		{"claude,pi", []string{"pi", "claude"}},
		{" CODEX, pi ", []string{"pi", "codex"}},
		{"pi,pi", []string{"pi"}},
		{"future,pi", []string{"pi", "future"}},
	}
	for _, tt := range tests {
		enabled, err := parseRuntime(tt.value, registry)
		if err != nil || !reflect.DeepEqual(enabled.enabledRuntimes(), tt.want) {
			t.Fatalf("parseRuntime(%q) = %v, %v; want %v", tt.value, enabled.enabledRuntimes(), err, tt.want)
		}
	}
	for _, value := range []string{"other", "pi,other", "pi,", "both,pi"} {
		if _, err := parseRuntime(value, registry); err == nil {
			t.Fatalf("parseRuntime(%q) accepted invalid input", value)
		}
	}
	if !runtimeSelectionIncludes(" PI, CLAUDE ", runtimes.ClaudeID) || runtimeSelectionIncludes("both", runtimes.ClaudeID) {
		t.Fatal("runtimeSelectionIncludes did not preserve the exact both alias")
	}
	got := codexCommand("/path with spaces/codex")
	if len(got) != 3 || got[0] != "/path with spaces/codex" || got[1] != "app-server" || got[2] != "--stdio" {
		t.Fatalf("argv = %#v", got)
	}
}

func TestResolveRuntimeSelectionAutoDiscoversInstalledCommandsInRegistryOrder(t *testing.T) {
	candidates := []runtimeCandidate{
		{id: runtimes.PiID, command: "pi"},
		{id: runtimes.CodexID, command: "/custom/codex"},
		{id: runtimes.ClaudeID, command: "claude"},
		{id: runtimes.OpenCodeID, command: "/custom/opencode"},
	}
	installed := map[string]bool{"pi": true, "claude": true, "/custom/opencode": true}
	selection, err := resolveRuntimeSelection(" AUTO ", candidates, func(command string) (string, error) {
		if installed[command] {
			return command, nil
		}
		return "", errors.New("not found")
	})
	if err != nil {
		t.Fatal(err)
	}
	if selection != "pi,claude,opencode" {
		t.Fatalf("selection = %q", selection)
	}
}

func TestResolveRuntimeSelectionPreservesExplicitOverride(t *testing.T) {
	selection, err := resolveRuntimeSelection("codex,pi", nil, func(string) (string, error) {
		t.Fatal("explicit selection performed discovery")
		return "", nil
	})
	if err != nil || selection != "codex,pi" {
		t.Fatalf("selection = %q, err = %v", selection, err)
	}
}

func TestResolveRuntimeSelectionRejectsEmptyDiscovery(t *testing.T) {
	_, err := resolveRuntimeSelection("auto", []runtimeCandidate{{id: runtimes.PiID, command: "pi"}}, func(string) (string, error) {
		return "", errors.New("not found")
	})
	if err == nil {
		t.Fatal("empty discovery was accepted")
	}
}

func TestOpenCodeExecutablePrecedence(t *testing.T) {
	t.Setenv("PICAN_OPENCODE_COMMAND", "/env/opencode")
	if got := openCodeExecutable("/flag/opencode"); got != "/flag/opencode" {
		t.Fatalf("flag command = %q", got)
	}
	if got := openCodeExecutable(""); got != "/env/opencode" {
		t.Fatalf("environment command = %q", got)
	}
	if err := os.Unsetenv("PICAN_OPENCODE_COMMAND"); err != nil {
		t.Fatal(err)
	}
	if got := openCodeExecutable(""); got == "" {
		t.Fatal("default OpenCode command is empty")
	}
}

func TestRuntimeModelsDispatchesThroughRegistryAndDegradesAfterSuccess(t *testing.T) {
	codexErr := errors.New("codex unavailable")
	piRegistration := testRuntimeRegistry(t, runtimes.PiID).registry.List()[0]
	piRegistration.Descriptor.Capabilities.ModelListing = true
	codexRegistration := testRuntimeRegistry(t, runtimes.CodexID).registry.List()[0]
	codexRegistration.Descriptor.Capabilities.ModelListing = true
	futureRegistration := testRuntimeRegistry(t, "future").registry.List()[0]
	registry, err := newRuntimeRegistry(
		applicationRuntime{
			registration: piRegistration,
			models: func(context.Context) ([]json.RawMessage, error) {
				return []json.RawMessage{json.RawMessage(`{"id":"pi-model"}`)}, nil
			},
		},
		applicationRuntime{
			registration: codexRegistration,
			models: func(context.Context) ([]json.RawMessage, error) {
				return nil, codexErr
			},
		},
		applicationRuntime{registration: futureRegistration},
	)
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := parseRuntime("pi,codex,future", registry)
	if err != nil {
		t.Fatal(err)
	}
	data, err := runtimeModels(context.Background(), enabled, t.TempDir(), sessions.NewCache(), server.ModelQuery{})
	if err != nil || string(data) != `{"models":[{"id":"pi-model"}]}` {
		t.Fatalf("aggregate models = %s, %v", data, err)
	}
	if _, err := runtimeModels(context.Background(), enabled, t.TempDir(), sessions.NewCache(), server.ModelQuery{Runtime: "codex"}); !errors.Is(err, codexErr) {
		t.Fatalf("targeted Codex error = %v, want %v", err, codexErr)
	}
	if _, err := runtimeModels(context.Background(), enabled, t.TempDir(), sessions.NewCache(), server.ModelQuery{Runtime: "future"}); err == nil {
		t.Fatal("runtime without model-listing capability was accepted")
	}
}

func TestCatalogSyncerAvailabilityTracksSyncResult(t *testing.T) {
	wantErr := errors.New("offline")
	syncer := newCatalogSyncer("Codex", func(context.Context) (runtimes.CatalogResult, error) {
		return runtimes.CatalogResult{Complete: true}, wantErr
	}, time.Second, time.Minute)
	result, err := syncer.Sync(context.Background())
	if !errors.Is(err, wantErr) {
		t.Fatalf("Sync error = %v, want %v", err, wantErr)
	}
	if result.Complete {
		t.Fatal("failed catalog sync remained complete")
	}
	status := syncer.availability(context.Background())
	if status.Available || status.Reason != "Codex runtime is unavailable: offline" {
		t.Fatalf("availability = %+v", status)
	}
}

func TestCatalogSyncerSingleFlightAndShutdown(t *testing.T) {
	var active atomic.Int32
	var maximum atomic.Int32
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	syncer := newCatalogSyncer("test", func(ctx context.Context) (runtimes.CatalogResult, error) {
		n := active.Add(1)
		defer active.Add(-1)
		for {
			old := maximum.Load()
			if n <= old || maximum.CompareAndSwap(old, n) {
				break
			}
		}
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
			return runtimes.CatalogResult{Complete: true}, nil
		case <-ctx.Done():
			return runtimes.CatalogResult{}, ctx.Err()
		}
	}, time.Second, time.Millisecond)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = syncer.Sync(context.Background()) }()
	<-started
	go func() { defer wg.Done(); _, _ = syncer.Sync(context.Background()) }()
	close(release)
	wg.Wait()
	if maximum.Load() != 1 {
		t.Fatalf("maximum concurrent syncs = %d", maximum.Load())
	}

	syncer.start(false)
	done := make(chan struct{})
	go func() { syncer.close(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("catalog syncer did not stop")
	}
}

func TestCatalogSyncerShutdownCancelsActiveSync(t *testing.T) {
	started := make(chan struct{})
	syncer := newCatalogSyncer("test", func(ctx context.Context) (runtimes.CatalogResult, error) {
		close(started)
		<-ctx.Done()
		return runtimes.CatalogResult{}, ctx.Err()
	}, time.Minute, time.Millisecond)
	syncer.start(false)
	<-started
	done := make(chan struct{})
	go func() {
		syncer.close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("catalog shutdown did not cancel active sync")
	}
}

func TestCatalogSyncerCanRetryImmediately(t *testing.T) {
	called := make(chan struct{}, 1)
	syncer := newCatalogSyncer("test", func(context.Context) (runtimes.CatalogResult, error) {
		called <- struct{}{}
		return runtimes.CatalogResult{Complete: true}, nil
	}, time.Second, time.Hour)
	syncer.start(true)
	defer syncer.close()
	select {
	case <-called:
	case <-time.After(time.Second):
		t.Fatal("immediate catalog retry did not run")
	}
}
