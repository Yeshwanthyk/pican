package server

import (
	"testing"
	"time"
)

func drainOnce(c *sseClient, timeout time.Duration) (string, bool) {
	select {
	case msg := <-c.ch:
		key := eventKey(msg)
		if key != "" {
			c.mu.Lock()
			delete(c.queued, key)
			c.mu.Unlock()
		}
		return msg, true
	case <-time.After(timeout):
		return "", false
	}
}

func TestBroadcastCoalescesReloads(t *testing.T) {
	s := newTestServer(t)
	defer s.Shutdown()
	c := s.addClient("sess-1")

	s.broadcast("sess-1", "reload")
	s.broadcast("sess-1", "reload")
	s.broadcast("sess-1", "reload")

	got1, ok := drainOnce(c, 100*time.Millisecond)
	if !ok || got1 != "reload" {
		t.Fatalf("expected 1st reload, got %q ok=%v", got1, ok)
	}
	s.broadcast("sess-1", "reload")
	got2, ok := drainOnce(c, 100*time.Millisecond)
	if !ok || got2 != "reload" {
		t.Fatalf("expected 2nd reload after drain, got %q ok=%v", got2, ok)
	}
	if _, ok := drainOnce(c, 50*time.Millisecond); ok {
		t.Fatal("expected channel empty, got extra event")
	}
}

func TestBroadcastDeliversReloadAndStatusIndependently(t *testing.T) {
	s := newTestServer(t)
	defer s.Shutdown()
	c := s.addClient("sess-2")

	s.broadcast("sess-2", "reload")
	s.broadcast("sess-2", "event: status-delta\ndata: {\"id\":\"sess-2\",\"running\":true}")

	got1, ok := drainOnce(c, 100*time.Millisecond)
	if !ok {
		t.Fatal("expected first event")
	}
	got2, ok := drainOnce(c, 100*time.Millisecond)
	if !ok {
		t.Fatal("expected second event")
	}
	if got1 == got2 {
		t.Fatalf("expected distinct events, got %q twice", got1)
	}
}
