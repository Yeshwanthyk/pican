package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func drainBroadcast(t *testing.T, c *sseClient, timeout time.Duration) bool {
	t.Helper()
	select {
	case <-c.ch:
		return true
	case <-time.After(timeout):
		return false
	}
}

func TestFsnotifyWatcherBroadcastsOnAppend(t *testing.T) {
	root := t.TempDir()
	projectDir := filepath.Join(root, "--tmp--project--")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionPath := filepath.Join(projectDir, "session.jsonl")
	if err := os.WriteFile(sessionPath, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{sessionsDir: root, fileMod: make(map[string]time.Time), lastKnown: make(map[string]struct{}), now: time.Now}
	if err := s.watchFilesFsnotify(); err != nil {
		t.Skipf("fsnotify unavailable on this platform: %v", err)
	}

	client := s.addClient("session.jsonl")
	defer s.removeClient(client)

	time.Sleep(20 * time.Millisecond)

	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(sessionPath, future, future); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(sessionPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(`{"type":"message"}` + "\n")
	f.Close()

	if !drainBroadcast(t, client, 2*time.Second) {
		t.Fatalf("expected reload broadcast after file append")
	}
}

func TestFsnotifyHandlesAtomicRenameReplacement(t *testing.T) {
	root := t.TempDir()
	projectDir := filepath.Join(root, "--tmp--project--")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionPath := filepath.Join(projectDir, "session.jsonl")
	if err := os.WriteFile(sessionPath, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{sessionsDir: root, fileMod: map[string]time.Time{"session.jsonl": time.Unix(1, 0)}, lastKnown: make(map[string]struct{}), now: time.Now}
	client := s.addClient("session.jsonl")
	debum := newDebouncer(time.Millisecond)
	done := make(chan struct{})
	go func() { debum.run(s); close(done) }()
	defer func() { debum.stop(); <-done; s.removeClient(client) }()

	s.handleFsEvent(nil, fsnotify.Event{Name: sessionPath, Op: fsnotify.Rename}, debum)
	if !drainBroadcast(t, client, time.Second) {
		t.Fatal("expected reload broadcast after atomic rename replacement")
	}
}

func TestFsnotifyCreateForKnownProjectionDoesNotBroadcastNewSession(t *testing.T) {
	root := t.TempDir()
	sessionPath := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(sessionPath, []byte("replacement\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		sessionsDir: root,
		fileMod:     map[string]time.Time{"session.jsonl": time.Now()},
		lastKnown:   make(map[string]struct{}),
	}
	client := s.addClient(globalSessID)
	defer s.removeClient(client)
	debum := newDebouncer(time.Hour)
	defer debum.stop()

	s.handleFsEvent(nil, fsnotify.Event{Name: sessionPath, Op: fsnotify.Create}, debum)

	select {
	case msg := <-client.ch:
		t.Fatalf("known projection replacement broadcast %q", msg)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestFsnotifyCreateForUnknownSessionBroadcastsNewSession(t *testing.T) {
	root := t.TempDir()
	sessionPath := filepath.Join(root, "session.jsonl")
	if err := os.WriteFile(sessionPath, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{
		sessionsDir: root,
		fileMod:     make(map[string]time.Time),
		lastKnown:   make(map[string]struct{}),
	}
	client := s.addClient(globalSessID)
	defer s.removeClient(client)
	debum := newDebouncer(time.Hour)
	defer debum.stop()

	s.handleFsEvent(nil, fsnotify.Event{Name: sessionPath, Op: fsnotify.Create}, debum)

	select {
	case msg := <-client.ch:
		if msg != "new-session" {
			t.Fatalf("broadcast = %q, want new-session", msg)
		}
	case <-time.After(time.Second):
		t.Fatal("expected new-session broadcast")
	}
}

func TestPollingFallbackBroadcastsOnAppend(t *testing.T) {
	root := t.TempDir()
	projectDir := filepath.Join(root, "--tmp--project--")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionPath := filepath.Join(projectDir, "session.jsonl")
	if err := os.WriteFile(sessionPath, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{sessionsDir: root, fileMod: make(map[string]time.Time), lastKnown: make(map[string]struct{}), now: time.Now}
	s.scanForChanges()

	client := s.addClient("session.jsonl")
	defer s.removeClient(client)

	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(sessionPath, future, future); err != nil {
		t.Fatal(err)
	}

	s.scanForChanges()

	if !drainBroadcast(t, client, 100*time.Millisecond) {
		t.Fatalf("expected reload broadcast after scanForChanges")
	}
}

func TestRecordModTimeGlobalBroadcastCarriesSessionID(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	s := &Server{
		sessionsDir: root,
		fileMod:     map[string]time.Time{"session.jsonl": now.Add(-10 * time.Second)},
		clients:     make([]*sseClient, 0),
		lastKnown:   make(map[string]struct{}),
		chatSender:  &fakeSender{},
		now:         time.Now,
	}
	globalClient := s.addClient(globalSessID)
	defer s.removeClient(globalClient)
	sessionClient := s.addClient("session.jsonl")
	defer s.removeClient(sessionClient)

	s.recordModTime("session.jsonl", time.Now())

	// The session-scoped topic still gets the plain "reload" other consumers
	// (live-events.js) depend on — unchanged.
	select {
	case msg := <-sessionClient.ch:
		if msg != "reload" {
			t.Fatalf("session-scoped broadcast = %q, want plain %q", msg, "reload")
		}
	case <-time.After(time.Second):
		t.Fatalf("expected a reload broadcast on the session-scoped topic")
	}

	// The global (__all__) topic carries the touched session id so
	// SessionsPage can damp its refetch instead of reloading on every append.
	select {
	case msg := <-globalClient.ch:
		if msg != "reload:session.jsonl" {
			t.Fatalf("global broadcast = %q, want %q", msg, "reload:session.jsonl")
		}
	case <-time.After(time.Second):
		t.Fatalf("expected a reload broadcast on the global topic")
	}
}

func TestRecordModTimeBroadcastsStatusDelta(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	s := &Server{
		sessionsDir: root,
		fileMod:     map[string]time.Time{"session.jsonl": now.Add(-10 * time.Second)},
		clients:     make([]*sseClient, 0),
		lastKnown:   make(map[string]struct{}),
		chatSender:  &fakeSender{},
		now:         time.Now,
	}
	c := s.addClient(globalSessID)
	defer s.removeClient(c)

	// Advance modtime to "now"; this is a recent-activity flip from idle to running.
	s.recordModTime("session.jsonl", time.Now())

	// __all__ subscriber now also receives "reload" for any existing-session
	// modification, followed by the status-delta.
	if !drainBroadcast(t, c, time.Second) {
		t.Fatalf("expected reload broadcast on __all__")
	}

	select {
	case msg := <-c.ch:
		if !strings.Contains(msg, "status-delta") || !strings.Contains(msg, "session.jsonl") || !strings.Contains(msg, "true") {
			t.Fatalf("unexpected msg after reload: %q", msg)
		}
	case <-time.After(time.Second):
		t.Fatalf("expected status-delta on __all__")
	}
}
