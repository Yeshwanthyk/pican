package claude

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pican/internal/sessions"
)

func TestClaudeProjectionIsDeterministicAndTranslatesTools(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000010"
	path := copyFixture(t, "transcript-tools.jsonl", nativeID, "-tmp-pican-claude-fixture")
	transcript, err := ParseTranscript(path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := json.Marshal(projectTranscript(transcript))
	if err != nil {
		t.Fatal(err)
	}
	second, err := json.Marshal(projectTranscript(transcript))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatal("projection output is not deterministic")
	}
	text := string(first)
	for _, expected := range []string{`"name":"Synthetic tool session"`, `"type":"thinking"`, `"type":"toolCall"`, `"name":"Read"`, `"role":"toolResult"`, `"toolCallId":"toolu_fixture"`, `"totalTokens":11`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("projection missing %s:\n%s", expected, text)
		}
	}
}

func TestClaudeProjectionCountsRepeatedNativeMessageUsageOnce(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000010"
	path := copyFixture(t, "transcript-tools.jsonl", nativeID, "-tmp-pican-claude-fixture")
	transcript, err := ParseTranscript(path)
	if err != nil {
		t.Fatal(err)
	}
	var firstMessageID string
	for index := range transcript.Records {
		rec := &transcript.Records[index]
		if rec.Type != "assistant" || rec.Message == nil {
			continue
		}
		if firstMessageID == "" {
			firstMessageID = rec.Message.ID
		} else {
			rec.Message.ID = firstMessageID
		}
	}
	usageEntries := 0
	for _, entry := range projectTranscript(transcript) {
		message, _ := entry["message"].(map[string]any)
		if message["usage"] != nil {
			usageEntries++
		}
	}
	if usageEntries != 1 {
		t.Fatalf("usage-bearing entries = %d, want one per native message id", usageEntries)
	}
}

func TestMaterializeNeverMutatesNativeTranscriptAndPreservesLocalMetadata(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000010"
	nativePath := copyFixture(t, "transcript-tools.jsonl", nativeID, "-tmp-pican-claude-fixture")
	before, err := os.ReadFile(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	transcript, err := ParseTranscript(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	sessionsDir := t.TempDir()
	projection, err := Materialize(sessionsDir, transcript)
	if err != nil {
		t.Fatal(err)
	}
	storePath := projection.Path
	if err := sessions.RenameSession(storePath, "Local projection title", nil); err != nil {
		t.Fatal(err)
	}
	projectedEntries := projectTranscript(transcript)
	if len(projectedEntries) < 2 {
		t.Fatalf("projected entries = %d, want a user entry", len(projectedEntries))
	}
	targetID, _ := projectedEntries[1]["id"].(string)
	if targetID == "" {
		t.Fatal("projected user entry has no deterministic id")
	}
	if err := sessions.LabelSessionEntry(storePath, targetID, "checkpoint", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Materialize(sessionsDir, transcript); err != nil {
		t.Fatal(err)
	}
	projected, err := os.ReadFile(storePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(projected), `"name":"Local projection title"`) ||
		!strings.Contains(string(projected), `"label":"checkpoint"`) ||
		!strings.Contains(string(projected), `"targetId":"`+targetID+`"`) {
		t.Fatalf("local metadata was not preserved:\n%s", projected)
	}
	metadata, err := ReadProjectionMetadata(storePath)
	if err != nil || metadata.NativeID != nativeID || metadata.Model != "claude-sonnet-4-5-20250929" {
		t.Fatalf("projection metadata = %+v, %v", metadata, err)
	}
	parsed, err := sessions.ParseFile(storePath, filepath.Base(filepath.Dir(storePath)), filepath.Base(storePath))
	if err != nil || parsed.Runtime != "claude" || parsed.NativeID != nativeID || parsed.Name != "Local projection title" {
		t.Fatalf("parsed projection = %+v, %v", parsed.SessionSummary, err)
	}
	after, err := os.ReadFile(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	afterInfo, err := os.Stat(nativePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) || beforeInfo.Mode() != afterInfo.Mode() || !beforeInfo.ModTime().Equal(afterInfo.ModTime()) {
		t.Fatal("materialization modified the authoritative Claude transcript")
	}
}
