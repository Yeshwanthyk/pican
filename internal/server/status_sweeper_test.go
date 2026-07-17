package server

import (
	"strings"
	"testing"
	"time"
)

func TestSweepStatusFlipsStaleRunningToIdle(t *testing.T) {
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	s := &Server{
		sessionsDir: t.TempDir(),
		chatSender:  &fakeSender{},
		clients:     make([]*sseClient, 0),
		fileMod:     map[string]time.Time{"a.jsonl": now.Add(-10 * time.Second)},
		lastKnown:   map[string]struct{}{"a.jsonl": {}},
		now:         func() time.Time { return now },
	}
	c := s.addClient(globalSessID)
	defer s.removeClient(c)

	s.sweepStatusOnce()

	select {
	case msg := <-c.ch:
		if !strings.Contains(msg, "status-delta") || !strings.Contains(msg, `"running":false`) {
			t.Fatalf("unexpected msg: %q", msg)
		}
	case <-time.After(time.Second):
		t.Fatalf("expected idle delta")
	}
	if _, still := s.lastKnown["a.jsonl"]; still {
		t.Fatalf("lastKnown should no longer contain a.jsonl")
	}
}

func TestSweepStatusKeepsStillRunning(t *testing.T) {
	now := time.Now()
	s := &Server{
		sessionsDir: t.TempDir(),
		chatSender:  &fakeSender{},
		clients:     make([]*sseClient, 0),
		fileMod:     map[string]time.Time{"a.jsonl": now.Add(-400 * time.Millisecond)},
		lastKnown:   map[string]struct{}{"a.jsonl": {}},
		now:         func() time.Time { return now },
	}
	c := s.addClient(globalSessID)
	defer s.removeClient(c)

	s.sweepStatusOnce()

	select {
	case msg := <-c.ch:
		t.Fatalf("unexpected broadcast on still-running session: %q", msg)
	case <-time.After(50 * time.Millisecond):
	}
	if _, ok := s.lastKnown["a.jsonl"]; !ok {
		t.Fatalf("lastKnown should still contain a.jsonl")
	}
}
