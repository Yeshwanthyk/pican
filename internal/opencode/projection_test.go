package opencode

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pican/internal/sessions"
)

func TestMaterializeProjectsKnownAndUnknownPartsAndPreservesLocalMetadata(t *testing.T) {
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	native := testNativeSession("ses-1", cwd, "Native title")
	messages := []Message{testMessage("ses-1", "msg-user", "user", Part{ID: "part-user", SessionID: "ses-1", MessageID: "msg-user", Type: "text", Text: "hello", Raw: json.RawMessage(`{"id":"part-user","sessionID":"ses-1","messageID":"msg-user","type":"text","text":"hello"}`)}), testMessage("ses-1", "msg-assistant", "assistant",
		Part{ID: "part-reason", SessionID: "ses-1", MessageID: "msg-assistant", Type: "reasoning", Text: "thinking", Raw: json.RawMessage(`{"id":"part-reason","type":"reasoning","text":"thinking"}`)},
		Part{ID: "part-unknown", SessionID: "ses-1", MessageID: "msg-assistant", Type: "future-part", Raw: json.RawMessage(`{"id":"part-unknown","type":"future-part","future":true}`)},
	)}
	projection, err := Materialize(sessionsDir, native, messages)
	if err != nil {
		t.Fatal(err)
	}
	if err := sessions.RenameSession(projection.Path, "Local title", func() time.Time { return time.Unix(20, 0).UTC() }); err != nil {
		t.Fatal(err)
	}
	if _, err := Materialize(sessionsDir, native, messages); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{`"runtime":"opencode"`, `"nativeId":"ses-1"`, `"customType":"opencode:future-part"`, `"future":true`, `"name":"Local title"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("projection missing %s:\n%s", want, text)
		}
	}

	session, err := sessions.ParseFile(projection.Path, filepath.Base(filepath.Dir(projection.Path)), filepath.Base(projection.Path))
	if err != nil {
		t.Fatal(err)
	}
	var target string
	for _, entry := range session.Entries {
		if entry["opencodePartId"] == "part-unknown" {
			target, _ = entry["id"].(string)
		}
	}
	if target == "" {
		t.Fatal("unknown native part was not projected")
	}
	messageID, err := ResolveMessageID(projection.Path, target)
	if err != nil {
		t.Fatal(err)
	}
	if messageID != "msg-assistant" {
		t.Fatalf("message id = %q", messageID)
	}
}

func TestMaterializeMigratesCanonicalDirectoryProjection(t *testing.T) {
	sessionsDir := t.TempDir()
	root := t.TempDir()
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "second")
	if err := os.MkdirAll(first, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(second, 0o755); err != nil {
		t.Fatal(err)
	}
	oldProjection, err := Materialize(sessionsDir, testNativeSession("ses-move", first, "first"), nil)
	if err != nil {
		t.Fatal(err)
	}
	newProjection, err := Materialize(sessionsDir, testNativeSession("ses-move", second, "second"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if oldProjection.Path == newProjection.Path {
		t.Fatal("cwd move did not relocate projection")
	}
	if _, err := os.Stat(oldProjection.Path); !os.IsNotExist(err) {
		t.Fatalf("old projection still exists: %v", err)
	}
}
