package sessions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadTitleInputsTreatsMarkedHeaderNameAsAutoTitle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	content := `{"type":"session","name":"New Codex session","autoTitle":true}` + "\n" +
		`{"type":"message","message":{"role":"user","content":"fix codex session naming"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	inputs, err := ReadTitleInputs(path)
	if err != nil {
		t.Fatal(err)
	}
	if !inputs.HasExplicitName || !inputs.AutoTitled {
		t.Fatalf("title inputs = %+v, want marked auto-title", inputs)
	}
}

func TestReadTitleInputsBuildsBoundedConversationContext(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	content := `{"type":"session","version":3}` + "\n" +
		`{"type":"message","message":{"role":"user","content":"Investigate reconnect behavior"}}` + "\n" +
		`{"type":"message","message":{"role":"assistant","content":"The stale list appears after the stream reconnects."}}` + "\n" +
		`{"type":"message","message":{"role":"user","content":"Fix the synchronization lifecycle and add a regression test"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	inputs, err := ReadTitleInputs(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(inputs.ConversationText, "USER:\nInvestigate reconnect behavior") {
		t.Fatalf("conversation missing first user message: %q", inputs.ConversationText)
	}
	if !strings.Contains(inputs.ConversationText, "ASSISTANT:\nThe stale list") {
		t.Fatalf("conversation missing assistant context: %q", inputs.ConversationText)
	}
	if !strings.Contains(inputs.ConversationText, "Fix the synchronization lifecycle") {
		t.Fatalf("conversation missing latest user message: %q", inputs.ConversationText)
	}
}
