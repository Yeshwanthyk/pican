package claude

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func copyFixture(t *testing.T, fixture, nativeID, projectName string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(t.TempDir(), projectName)
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(project, nativeID+".jsonl")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestParseTranscriptPreservesUnknownAndSkipsMalformedCompleteLines(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000001"
	path := copyFixture(t, "transcript-unknown-malformed.jsonl", nativeID, "-tmp-pican-claude-fixture")
	transcript, err := ParseTranscript(path)
	if err != nil {
		t.Fatal(err)
	}
	if transcript.NativeID != nativeID || transcript.CWD != "/tmp/pican-claude-fixture" || transcript.Preview != "Synthetic fixture prompt" || transcript.Model != "claude-haiku-4-5-20251001" {
		t.Fatalf("transcript metadata = %+v", transcript)
	}
	if transcript.Complete || !reflect.DeepEqual(transcript.MalformedLines, []int{3}) || transcript.IncompleteTail {
		t.Fatalf("parse completeness = complete:%v malformed:%v tail:%v", transcript.Complete, transcript.MalformedLines, transcript.IncompleteTail)
	}
	entries := projectTranscript(transcript)
	if len(entries) != 4 {
		t.Fatalf("projected entries = %d, want header + user + unknown + assistant", len(entries))
	}
	unknown := entries[2]
	if unknown["type"] != "custom_message" || unknown["customType"] != "claude:future-record" || unknown["claudeRaw"] == nil {
		t.Fatalf("unknown record projection = %#v", unknown)
	}
	encoded, err := json.Marshal(entries)
	if err != nil || !strings.Contains(string(encoded), `"opaque":true`) {
		t.Fatalf("unknown raw payload missing: %s, %v", encoded, err)
	}
}

func TestParseTranscriptIgnoresIncompleteTail(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000004"
	path := copyFixture(t, "transcript-incomplete-tail.jsonl", nativeID, "-tmp-pican-claude-fixture")
	transcript, err := ParseTranscript(path)
	if err != nil {
		t.Fatal(err)
	}
	if transcript.Complete || !transcript.IncompleteTail || len(transcript.Records) != 1 {
		t.Fatalf("incomplete-tail parse = complete:%v tail:%v records:%d", transcript.Complete, transcript.IncompleteTail, len(transcript.Records))
	}
	entries := projectTranscript(transcript)
	if len(entries) != 2 || entries[1]["message"].(map[string]any)["role"] != "user" {
		t.Fatalf("projection included incomplete tail: %#v", entries)
	}
}

func TestParseTranscriptSnapshotExcludesConcurrentAppendAndRecovers(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000020"
	project := filepath.Join(t.TempDir(), "-tmp-pican-claude-fixture")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(project, nativeID+".jsonl")
	first := `{"type":"user","cwd":"/tmp/pican-claude-fixture","sessionId":"` + nativeID + `","message":{"role":"user","content":"first"},"uuid":"00000000-0000-4000-8000-000000000021","timestamp":"2026-01-01T00:00:00Z"}` + "\n"
	second := `{"type":"assistant","cwd":"/tmp/pican-claude-fixture","sessionId":"` + nativeID + `","message":{"role":"assistant","model":"sonnet","content":[{"type":"text","text":"second"}]},"uuid":"00000000-0000-4000-8000-000000000022","timestamp":"2026-01-01T00:00:01Z"}` + "\n"
	if err := os.WriteFile(path, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	transcript, err := parseTranscript(path, func() {
		f, openErr := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		if openErr != nil {
			t.Fatal(openErr)
		}
		if _, writeErr := f.WriteString(second); writeErr != nil {
			t.Fatal(writeErr)
		}
		if closeErr := f.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if transcript.Complete || len(transcript.Records) != 1 {
		t.Fatalf("snapshot consumed concurrent append: complete=%v records=%d", transcript.Complete, len(transcript.Records))
	}
	recovered, err := ParseTranscript(path)
	if err != nil || !recovered.Complete || len(recovered.Records) != 2 {
		t.Fatalf("recovered parse = complete:%v records:%d err:%v", recovered.Complete, len(recovered.Records), err)
	}
}

func TestParseTranscriptKeepsFirstCWDAndDowngradesConflicts(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000040"
	path := filepath.Join(t.TempDir(), nativeID+".jsonl")
	data := `{"type":"user","cwd":"/tmp/project-a","sessionId":"` + nativeID + `","message":{"role":"user","content":"first"},"uuid":"00000000-0000-4000-8000-000000000041","timestamp":"2026-01-01T00:00:00Z"}` + "\n" +
		`{"type":"assistant","cwd":"/tmp/project-b","sessionId":"` + nativeID + `","message":{"role":"assistant","model":"sonnet","content":[{"type":"text","text":"second"}]},"uuid":"00000000-0000-4000-8000-000000000042","timestamp":"2026-01-01T00:00:01Z"}` + "\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	transcript, err := ParseTranscript(path)
	if err != nil {
		t.Fatal(err)
	}
	if transcript.Complete || transcript.CWD != projectionsCanonicalForTest("/tmp/project-a") || !reflect.DeepEqual(transcript.MalformedLines, []int{2}) {
		t.Fatalf("conflicting cwd parse = complete:%v cwd:%q malformed:%v", transcript.Complete, transcript.CWD, transcript.MalformedLines)
	}
}

func TestParseTranscriptInfersCWDAndRejectsIdentityMismatch(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000030"
	path := copyFixture(t, "transcript-tools.jsonl", nativeID, "-Users-example-workspace")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.ReplaceAll(string(data), "00000000-0000-4000-8000-000000000010", nativeID))
	var first map[string]any
	lines := strings.Split(string(data), "\n")
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatal(err)
	}
	delete(first, "cwd")
	lines[0] = compactJSON(first)
	for index := 1; index < len(lines); index++ {
		if strings.TrimSpace(lines[index]) == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(lines[index]), &entry) == nil {
			delete(entry, "cwd")
			lines[index] = compactJSON(entry)
		}
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o600); err != nil {
		t.Fatal(err)
	}
	transcript, err := ParseTranscript(path)
	if err != nil || transcript.CWD != "/Users/example/workspace" || transcript.Title != "Synthetic tool session" {
		t.Fatalf("fallback parse = cwd:%q title:%q err:%v", transcript.CWD, transcript.Title, err)
	}

	mismatch := filepath.Join(filepath.Dir(path), "00000000-0000-4000-8000-000000000099.jsonl")
	if err := os.WriteFile(mismatch, data, 0o600); err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseTranscript(mismatch)
	if !errors.Is(err, ErrNoTranscriptRecords) || parsed.Complete {
		t.Fatalf("identity mismatch = complete:%v err:%v", parsed.Complete, err)
	}
}
