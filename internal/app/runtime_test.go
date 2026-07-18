package app

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseRuntimeAndCodexCommand(t *testing.T) {
	for _, value := range []string{"pi", "codex", "both"} {
		mode, err := parseRuntime(value)
		if err != nil || string(mode) != value {
			t.Fatalf("parseRuntime(%q) = %q, %v", value, mode, err)
		}
	}
	if _, err := parseRuntime("other"); err == nil {
		t.Fatal("invalid runtime accepted")
	}
	got := codexCommand("/path with spaces/codex")
	if len(got) != 3 || got[0] != "/path with spaces/codex" || got[1] != "app-server" || got[2] != "--stdio" {
		t.Fatalf("argv = %#v", got)
	}
}

func TestCatalogSyncerSingleFlightAndShutdown(t *testing.T) {
	var active atomic.Int32
	var maximum atomic.Int32
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	syncer := newCatalogSyncer(func(ctx context.Context) error {
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
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}, time.Second, time.Millisecond)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = syncer.sync(context.Background()) }()
	<-started
	go func() { defer wg.Done(); _ = syncer.sync(context.Background()) }()
	close(release)
	wg.Wait()
	if maximum.Load() != 1 {
		t.Fatalf("maximum concurrent syncs = %d", maximum.Load())
	}

	syncer.start()
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
	syncer := newCatalogSyncer(func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	}, time.Minute, time.Millisecond)
	syncer.start()
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
