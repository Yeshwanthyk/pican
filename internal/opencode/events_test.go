package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"testing"
	"time"
)

func TestCatalogEventsCoalescesRefreshAndDeleteUsesCompleteSync(t *testing.T) {
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	native := testNativeSession("native", cwd, "native")
	stale, err := Materialize(sessionsDir, testNativeSession("stale", cwd, "stale"), nil)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeNativeClient{
		lists:      [][]Session{{native}, {native}},
		sessions:   map[string]Session{"native": native},
		messages:   map[string][]Message{"native": {testMessage("native", "msg", "user")}},
		messageErr: map[string]error{},
	}
	catalog, err := NewCatalog(sessionsDir, cwd, providerFor(fake))
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var projected []string
	var eventErrors []error
	events, err := NewCatalogEvents(catalog, time.Millisecond, CatalogEventCallbacks{
		Projection: func(projection Projection) {
			mu.Lock()
			projected = append(projected, projection.NativeID)
			mu.Unlock()
		},
		Error: func(err error) {
			mu.Lock()
			eventErrors = append(eventErrors, err)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	refresh := Event{
		Directory: cwd,
		Payload: EventPayload{
			Type:       "message.updated",
			Properties: json.RawMessage(`{"info":{"sessionID":"native"}}`),
		},
	}
	events.HandleEvent(refresh)
	events.HandleEvent(refresh)
	waitForEventCondition(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(projected) == 1
	})

	events.HandleEvent(Event{
		Directory: cwd,
		Payload: EventPayload{
			Type:       "session.deleted",
			Properties: json.RawMessage(`{"info":{"id":"stale"}}`),
		},
	})
	waitForEventCondition(t, func() bool {
		_, err := os.Stat(stale.Path)
		return os.IsNotExist(err)
	})
	events.Close()
	mu.Lock()
	defer mu.Unlock()
	if len(eventErrors) != 0 {
		t.Fatalf("event errors = %v", eventErrors)
	}
}

func TestCatalogSyncWithClientBypassesUnpublishedProvider(t *testing.T) {
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	native := testNativeSession("native", cwd, "native")
	fake := &fakeNativeClient{
		lists:      [][]Session{{native}, {native}},
		sessions:   map[string]Session{"native": native},
		messages:   map[string][]Message{"native": nil},
		messageErr: map[string]error{},
	}
	catalog, err := NewCatalog(sessionsDir, cwd, func() (NativeClient, error) {
		return nil, errors.New("generation is not published")
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := catalog.SyncWithClient(context.Background(), fake)
	if err != nil || !result.Complete || len(result.SessionIDs) != 1 {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
}

func waitForEventCondition(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition not reached")
}
