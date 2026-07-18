package server

import (
	"fmt"
	"testing"
	"time"
)

// drainOnce pops one message off c's channel, exercising the same
// resolveToken path as the real /events handler (see events.go), so tests
// see production coalescing/replacement behavior rather than a re-implementation.
func drainOnce(c *sseClient, timeout time.Duration) (string, bool) {
	select {
	case token := <-c.ch:
		return c.resolveToken(token), true
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

// TestBroadcastKeyedEventSurvivesFullChannel is a regression test: before the
// pending/signaled rework, a keyed broadcast (e.g. reload) that couldn't get
// a channel slot because the buffer was full was silently and permanently
// dropped — bookkeeping never marked it pending, so nothing ever retried it.
func TestBroadcastKeyedEventSurvivesFullChannel(t *testing.T) {
	s := newTestServer(t)
	defer s.Shutdown()
	c := s.addClient("sess-full")

	// Fill the 16-slot channel with keyless status-delta messages so the
	// upcoming keyed broadcast can't get a wake-up token queued immediately.
	for i := 0; i < 16; i++ {
		s.broadcast("sess-full", fmt.Sprintf("event: status-delta\ndata: {\"i\":%d}", i))
	}

	s.broadcast("sess-full", "reload")

	// Drain the keyless backlog. Each dequeue retries signaling any pending
	// keyed messages (flushPending), so reload should get a slot once room
	// opens up and eventually surface instead of vanishing.
	found := false
	for i := 0; i < 32; i++ {
		msg, ok := drainOnce(c, 200*time.Millisecond)
		if !ok {
			break
		}
		if msg == "reload" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected reload to eventually be delivered after the channel drains")
	}
}
