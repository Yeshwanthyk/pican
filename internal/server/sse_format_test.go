package server

import (
	"strings"
	"testing"
)

func TestFormatSSEJSONEventEscapesPayloadAsSingleDataLine(t *testing.T) {
	msg, err := formatSSEJSONEvent("chat-preview", map[string]any{
		"content": "hello\nworld",
		"done":    false,
	})
	if err != nil {
		t.Fatalf("formatSSEJSONEvent returned error: %v", err)
	}
	if !strings.HasPrefix(msg, "event: chat-preview\ndata: ") {
		t.Fatalf("message prefix = %q", msg)
	}
	if strings.Contains(msg, "\nworld") {
		t.Fatalf("payload newline was emitted as raw SSE newline: %q", msg)
	}
	if strings.HasSuffix(msg, "\n\n") {
		t.Fatalf("formatter should not append terminating blank line; handleEvents does that: %q", msg)
	}
	if !strings.Contains(msg, `"content":"hello\nworld"`) {
		t.Fatalf("payload was not JSON escaped: %q", msg)
	}
}

func TestFormatSSEJSONEventRejectsEmptyName(t *testing.T) {
	if _, err := formatSSEJSONEvent("", map[string]any{"ok": true}); err == nil {
		t.Fatalf("expected error for empty event name")
	}
}
