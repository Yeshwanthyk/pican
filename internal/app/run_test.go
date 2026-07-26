package app

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"pican/internal/agentdir"
)

func TestServeUntilCanceledStopsHTTPServer(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serveUntilCanceled(ctx, server, listener)
	}()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serveUntilCanceled() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("serveUntilCanceled did not return after cancellation")
	}
}

func TestCleanupStackClosesInReverseInitializationOrder(t *testing.T) {
	var got []string
	cleanups := cleanupStack{}
	cleanups.add(func() { got = append(got, "first") })
	cleanups.add(func() { got = append(got, "second") })
	cleanups.add(func() { got = append(got, "partial") })

	cleanups.close()

	want := []string{"partial", "second", "first"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cleanup order = %v, want %v", got, want)
	}
}

func TestHostedModeRejectsNonCodexRuntime(t *testing.T) {
	config := DefaultConfig("test")
	config.Mode = ModeHosted
	config.WorkspaceRoot = t.TempDir()
	config.Runtime = "claude"

	err := config.validate()
	if err == nil || err.Error() != "hosted mode supports only the Codex runtime" {
		t.Fatalf("validate() error = %v", err)
	}
}

func TestRunCancellationRemovesStateFileAndStopsOwnedServer(t *testing.T) {
	stateRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateRoot, "sessions"), 0o755); err != nil {
		t.Fatalf("create sessions directory: %v", err)
	}

	defaultModelsCache.mu.Lock()
	oldEntry := defaultModelsCache.entry
	defaultModelsCache.entry = &modelsCacheEntry{
		data: json.RawMessage(`{"models":[]}`),
		at:   time.Now(),
	}
	defaultModelsCache.mu.Unlock()
	t.Cleanup(func() {
		defaultModelsCache.mu.Lock()
		defaultModelsCache.entry = oldEntry
		defaultModelsCache.mu.Unlock()
	})

	config := DefaultConfig("test")
	config.StateRoot = stateRoot
	config.ListenAddress = "127.0.0.1:0"
	config.HostExplicit = true
	config.Runtime = "pi"

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, config)
	}()

	statePath := filepath.Join(agentdir.PicanDir(stateRoot), "pican-state.json")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(statePath); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("Run did not finish startup")
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancellation")
	}
	if _, err := os.Stat(statePath); !os.IsNotExist(err) {
		t.Fatalf("state file remains after Run returned: %v", err)
	}
}
