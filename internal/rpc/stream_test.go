package rpc

import "testing"

func TestStreamPreviewAccumulatorBuildsFullContentFromTextDeltas(t *testing.T) {
	acc := &streamPreviewAccumulator{}

	first, ok := acc.handleAssistantEvent(assistantMessageEvent{Type: "text_delta", Delta: "hel"})
	if !ok {
		t.Fatalf("first delta did not emit preview")
	}
	if first.Content != "hel" || first.Done {
		t.Fatalf("first preview = %+v, want content hel done false", first)
	}

	second, ok := acc.handleAssistantEvent(assistantMessageEvent{Type: "text_delta", Delta: "lo"})
	if !ok {
		t.Fatalf("second delta did not emit preview")
	}
	if second.Content != "hello" || second.Done {
		t.Fatalf("second preview = %+v, want content hello done false", second)
	}
}

func TestStreamPreviewAccumulatorUsesTextEndContentAndMarksDone(t *testing.T) {
	acc := &streamPreviewAccumulator{}
	_, _ = acc.handleAssistantEvent(assistantMessageEvent{Type: "text_delta", Delta: "draft"})

	preview, ok := acc.handleAssistantEvent(assistantMessageEvent{Type: "text_end", Content: "final"})
	if !ok {
		t.Fatalf("text_end did not emit preview")
	}
	if preview.Content != "final" || !preview.Done {
		t.Fatalf("preview = %+v, want final done preview", preview)
	}
}

func TestStreamPreviewAccumulatorIgnoresNonTextEvents(t *testing.T) {
	acc := &streamPreviewAccumulator{}
	if preview, ok := acc.handleAssistantEvent(assistantMessageEvent{Type: "thinking_end"}); ok {
		t.Fatalf("thinking event emitted preview: %+v", preview)
	}
}

func TestStreamPreviewAccumulatorCompletesExistingPreview(t *testing.T) {
	acc := &streamPreviewAccumulator{}
	_, _ = acc.handleAssistantEvent(assistantMessageEvent{Type: "text_delta", Delta: "hello"})

	preview, ok := acc.complete()
	if !ok {
		t.Fatalf("complete did not emit preview")
	}
	if preview.Content != "hello" || !preview.Done {
		t.Fatalf("preview = %+v, want hello done", preview)
	}
	if _, ok := acc.complete(); ok {
		t.Fatalf("second complete should not emit after reset")
	}
}
