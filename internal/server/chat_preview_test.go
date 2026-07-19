package server

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"pican/internal/rpc"
	"pican/internal/workers"
)

func TestBroadcastChatPreviewSendsNamedSSEToSession(t *testing.T) {
	s, err := New(Deps{AgentDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Shutdown()
	client := s.addClient("a.jsonl")
	defer s.removeClient(client)

	s.BroadcastChatPreview("a.jsonl", rpc.StreamPreview{Content: "hello\nworld", Done: false, TurnID: "turn-1", ItemID: "item-1"})

	msg, ok := drainOnce(client, time.Second)
	if !ok {
		t.Fatalf("expected chat-preview broadcast")
	}
	if !strings.HasPrefix(msg, "event: chat-preview\ndata: ") {
		t.Fatalf("msg = %q", msg)
	}
	if !strings.Contains(msg, `"content":"hello\nworld"`) {
		t.Fatalf("content was not JSON escaped in msg = %q", msg)
	}
	if !strings.Contains(msg, `"turnId":"turn-1"`) || !strings.Contains(msg, `"itemId":"item-1"`) {
		t.Fatalf("preview identity was lost in msg = %q", msg)
	}
}

func TestBroadcastWorkerStatusSendsExitCodeToSession(t *testing.T) {
	s := &Server{
		clients: make([]*sseClient, 0), lastKnown: make(map[string]struct{}),
		fileMod: make(map[string]time.Time), now: time.Now,
	}
	client := s.addClient("a.jsonl")
	exitCode := 17

	s.BroadcastWorkerStatus("a.jsonl", workers.WorkerStatus{
		State: workers.WorkerStateError, Error: "exit status 17", ExitCode: &exitCode,
	})

	select {
	case token := <-client.ch:
		got := client.resolveToken(token)
		if !strings.Contains(got, "event: worker-status") || !strings.Contains(got, `"exitCode":17`) {
			t.Fatalf("event = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for worker status")
	}
}

func TestBroadcastChatPreviewDoesNotSendToGlobalTopic(t *testing.T) {
	s, err := New(Deps{AgentDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Shutdown()
	client := s.addClient(globalSessID)
	defer s.removeClient(client)

	s.BroadcastChatPreview("a.jsonl", rpc.StreamPreview{Content: "secret", Done: false})

	if _, ok := drainOnce(client, 50*time.Millisecond); ok {
		t.Fatalf("global client received chat preview")
	}
}

// TestBroadcastChatPreviewCoalescesBurstToLatest is a regression test for the
// O(n^2)-flood bug: per-token preview pushes used to have no coalescing key,
// so a burst could occupy every channel slot and even drop keyed reload/
// new-session events queued alongside it. chat-preview is now keyed, so a
// burst collapses to a single slot and the client only ever sees the latest
// content.
func TestBroadcastChatPreviewCoalescesBurstToLatest(t *testing.T) {
	s, err := New(Deps{AgentDir: t.TempDir()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer s.Shutdown()
	client := s.addClient("a.jsonl")
	defer s.removeClient(client)

	for i := 0; i < 50; i++ {
		s.BroadcastChatPreview("a.jsonl", rpc.StreamPreview{Content: fmt.Sprintf("chunk-%d", i)})
	}
	s.BroadcastChatPreview("a.jsonl", rpc.StreamPreview{Content: "final", Done: true})

	msg, ok := drainOnce(client, time.Second)
	if !ok {
		t.Fatalf("expected a chat-preview message")
	}
	if !strings.Contains(msg, `"content":"final"`) || !strings.Contains(msg, `"done":true`) {
		t.Fatalf("expected latest coalesced preview, got %q", msg)
	}
	if _, ok := drainOnce(client, 50*time.Millisecond); ok {
		t.Fatal("expected only one coalesced chat-preview message, got a second")
	}
}
