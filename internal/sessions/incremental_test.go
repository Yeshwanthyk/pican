package sessions

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func appendToFile(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
}

// ── scanAppendedLines: the low-level tail scanner ───────────────────────────

func TestScanAppendedLinesStartsAtGivenOffset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.jsonl")
	// A garbage prefix that would corrupt a from-scratch parse if the scanner
	// ever read from byte 0 instead of the given offset.
	garbage := "not json at all\n"
	good1 := `{"a":1}` + "\n"
	good2 := `{"a":2}` + "\n"
	if err := os.WriteFile(path, []byte(garbage+good1+good2), 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var got []string
	newOffset, err := scanAppendedLines(f, int64(len(garbage)), func(line []byte) {
		got = append(got, string(line))
	})
	if err != nil {
		t.Fatalf("scanAppendedLines: %v", err)
	}
	want := []string{`{"a":1}`, `{"a":2}`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	wantOffset := int64(len(garbage) + len(good1) + len(good2))
	if newOffset != wantOffset {
		t.Fatalf("newOffset = %d, want %d", newOffset, wantOffset)
	}
}

func TestScanAppendedLinesLeavesPartialTrailingLineUnconsumed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.jsonl")
	complete := `{"a":1}` + "\n"
	partial := `{"a":2`
	if err := os.WriteFile(path, []byte(complete+partial), 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	var got []string
	newOffset, err := scanAppendedLines(f, 0, func(line []byte) { got = append(got, string(line)) })
	if err != nil {
		t.Fatalf("scanAppendedLines: %v", err)
	}
	if len(got) != 1 || got[0] != `{"a":1}` {
		t.Fatalf("got %v, want exactly the complete line", got)
	}
	if newOffset != int64(len(complete)) {
		t.Fatalf("newOffset = %d, want %d (must exclude the partial trailing line)", newOffset, len(complete))
	}
	f.Close()

	// Once the writer finishes the line, scanning again from newOffset must
	// pick up the now-complete line — not corrupt or drop it.
	if err := os.WriteFile(path, []byte(complete+partial+"}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	f2, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f2.Close()
	got = nil
	if _, err := scanAppendedLines(f2, newOffset, func(line []byte) { got = append(got, string(line)) }); err != nil {
		t.Fatalf("second scan: %v", err)
	}
	if len(got) != 1 || got[0] != `{"a":2}` {
		t.Fatalf("second scan got %v, want the now-complete line", got)
	}
}

func TestScanAppendedLinesNoNewData(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "f.jsonl")
	content := `{"a":1}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	called := false
	newOffset, err := scanAppendedLines(f, int64(len(content)), func(line []byte) { called = true })
	if err != nil {
		t.Fatalf("scanAppendedLines: %v", err)
	}
	if called {
		t.Fatal("onLine should not be called when there is nothing new")
	}
	if newOffset != int64(len(content)) {
		t.Fatalf("newOffset = %d, want %d", newOffset, len(content))
	}
}

// ── parseSummaryCached: incremental vs. full parse equivalence ─────────────

const testSessionHeader = `{"type":"session","version":3,"id":"sid","timestamp":"2026-01-01T00:00:00Z","cwd":"/tmp/project"}` + "\n"

func testMessageLine(i int) string {
	role := "user"
	if i%2 == 1 {
		role = "assistant"
	}
	return fmt.Sprintf(
		`{"type":"message","id":"m%04d","timestamp":"2026-01-01T00:%02d:%02dZ","message":{"role":"%s","content":"line %d","usage":{"totalTokens":%d,"cost":{"total":%f}}}}`+"\n",
		i, (i/60)%60, i%60, role, i, 10+i, 0.001*float64(i),
	)
}

func TestParseSummaryCachedIncrementalAppendMatchesFromScratch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(testSessionHeader+testMessageLine(0)), 0644); err != nil {
		t.Fatal(err)
	}

	summary1, state1, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", nil)
	if err != nil {
		t.Fatalf("initial parse: %v", err)
	}
	if summary1.MessageCount != 1 {
		t.Fatalf("MessageCount = %d, want 1", summary1.MessageCount)
	}

	appendToFile(t, path, testMessageLine(1)+testMessageLine(2))

	prior := &cacheEntry{summary: summary1, parse: state1}
	summary2, state2, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", prior)
	if err != nil {
		t.Fatalf("incremental parse: %v", err)
	}

	want, err := ParseSummary(path, "--tmp--project--", "s.jsonl")
	if err != nil {
		t.Fatalf("from-scratch parse: %v", err)
	}
	if !reflect.DeepEqual(summary2, want) {
		t.Fatalf("incremental summary = %+v, want %+v", summary2, want)
	}
	if summary2.MessageCount != 3 {
		t.Fatalf("MessageCount = %d, want 3", summary2.MessageCount)
	}
	if state2.offset <= state1.offset {
		t.Fatalf("offset should advance past the previous parse: state1=%d state2=%d", state1.offset, state2.offset)
	}
	info, _ := os.Stat(path)
	if state2.offset != info.Size() {
		t.Fatalf("offset = %d, want full file size %d (no trailing partial line)", state2.offset, info.Size())
	}
}

func TestParseSummaryCachedFallsBackOnTruncation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	full := testSessionHeader + testMessageLine(0) + testMessageLine(1)
	if err := os.WriteFile(path, []byte(full), 0644); err != nil {
		t.Fatal(err)
	}

	_, state1, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", nil)
	if err != nil {
		t.Fatalf("initial parse: %v", err)
	}

	// Truncate back to just the header + first message.
	truncated := testSessionHeader + testMessageLine(0)
	if err := os.WriteFile(path, []byte(truncated), 0644); err != nil {
		t.Fatal(err)
	}

	prior := &cacheEntry{parse: state1}
	summary2, state2, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", prior)
	if err != nil {
		t.Fatalf("parse after truncation: %v", err)
	}
	if summary2.MessageCount != 1 {
		t.Fatalf("MessageCount after truncation = %d, want 1 (must fall back to a full reparse)", summary2.MessageCount)
	}
	if state2.offset != int64(len(truncated)) {
		t.Fatalf("offset = %d, want %d", state2.offset, len(truncated))
	}
}

func TestParseSummaryCachedFallsBackOnHeaderMismatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(testSessionHeader+testMessageLine(0)), 0644); err != nil {
		t.Fatal(err)
	}

	_, state1, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", nil)
	if err != nil {
		t.Fatalf("initial parse: %v", err)
	}

	// Replace the file wholesale with a different session (different header,
	// same or larger size) — simulates the file being unlinked and recreated
	// under the same path.
	otherHeader := `{"type":"session","version":3,"id":"different-sid","timestamp":"2026-02-02T00:00:00Z","cwd":"/tmp/other"}` + "\n"
	replaced := otherHeader + testMessageLine(0) + testMessageLine(1) + testMessageLine(2)
	if err := os.WriteFile(path, []byte(replaced), 0644); err != nil {
		t.Fatal(err)
	}

	prior := &cacheEntry{parse: state1}
	summary2, _, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", prior)
	if err != nil {
		t.Fatalf("parse after replacement: %v", err)
	}
	if summary2.SessionUUID != "different-sid" {
		t.Fatalf("SessionUUID = %q, want %q (must fall back to a full reparse on header mismatch)", summary2.SessionUUID, "different-sid")
	}
	if summary2.MessageCount != 3 {
		t.Fatalf("MessageCount = %d, want 3", summary2.MessageCount)
	}
}

func TestParseSummaryCachedHandlesPartialTrailingLineAcrossCalls(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	partial := `{"type":"message","id":"partial","timestamp":"2026-01-01T00:00:05Z","message":{"role":"user","content":"unfinished`
	if err := os.WriteFile(path, []byte(testSessionHeader+testMessageLine(0)+partial), 0644); err != nil {
		t.Fatal(err)
	}

	summary1, state1, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", nil)
	if err != nil {
		t.Fatalf("initial parse: %v", err)
	}
	if summary1.MessageCount != 1 {
		t.Fatalf("MessageCount = %d, want 1 (partial trailing line must not be folded)", summary1.MessageCount)
	}

	// The writer finishes the line and moves on.
	appendToFile(t, path, `"}}`+"\n"+testMessageLine(2))

	prior := &cacheEntry{summary: summary1, parse: state1}
	summary2, _, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", prior)
	if err != nil {
		t.Fatalf("incremental parse: %v", err)
	}
	want, err := ParseSummary(path, "--tmp--project--", "s.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(summary2, want) {
		t.Fatalf("incremental summary = %+v, want %+v", summary2, want)
	}
	if summary2.MessageCount != 3 {
		t.Fatalf("MessageCount = %d, want 3", summary2.MessageCount)
	}
}

// TestParseSummaryCachedRandomizedAppends is a property-style test: build a
// file across many randomly-sized append batches, incrementally parsing
// after each one, and compare against a from-scratch ParseSummary at every
// step. Counters accumulated incrementally must always match a full reparse.
func TestParseSummaryCachedRandomizedAppends(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(testSessionHeader), 0644); err != nil {
		t.Fatal(err)
	}

	var prior *cacheEntry
	msgIdx := 0
	for round := 0; round < 40; round++ {
		batch := 1 + rng.Intn(4)
		var content string
		for i := 0; i < batch; i++ {
			content += testMessageLine(msgIdx)
			msgIdx++
		}
		appendToFile(t, path, content)

		summary, state, err := parseSummaryCached(path, "--tmp--project--", "s.jsonl", prior)
		if err != nil {
			t.Fatalf("round %d: parseSummaryCached: %v", round, err)
		}
		want, err := ParseSummary(path, "--tmp--project--", "s.jsonl")
		if err != nil {
			t.Fatalf("round %d: ParseSummary: %v", round, err)
		}
		if !reflect.DeepEqual(summary, want) {
			t.Fatalf("round %d: incremental = %+v, want %+v", round, summary, want)
		}
		prior = &cacheEntry{summary: summary, parse: state}
	}
}

// ── parseFileCached: same equivalence guarantees, over the full Session ────

func sessionsEqualIgnoringOrder(t *testing.T, a, b Session) bool {
	t.Helper()
	if !reflect.DeepEqual(a.SessionSummary, b.SessionSummary) {
		return false
	}
	if !reflect.DeepEqual(a.Header, b.Header) {
		return false
	}
	return reflect.DeepEqual(a.Entries, b.Entries)
}

func TestParseFileCachedIncrementalAppendMatchesFromScratch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(testSessionHeader+testMessageLine(0)), 0644); err != nil {
		t.Fatal(err)
	}

	session1, state1, err := parseFileCached(path, "--tmp--project--", "s.jsonl", nil)
	if err != nil {
		t.Fatalf("initial parse: %v", err)
	}
	if len(session1.Entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(session1.Entries))
	}

	appendToFile(t, path, testMessageLine(1)+testMessageLine(2))

	prior := &sessionCacheEntry{session: session1, parse: state1}
	session2, _, err := parseFileCached(path, "--tmp--project--", "s.jsonl", prior)
	if err != nil {
		t.Fatalf("incremental parse: %v", err)
	}

	want, err := ParseFile(path, "--tmp--project--", "s.jsonl")
	if err != nil {
		t.Fatalf("from-scratch parse: %v", err)
	}
	if !sessionsEqualIgnoringOrder(t, session2, want) {
		t.Fatalf("incremental session = %+v, want %+v", session2, want)
	}
	if len(session2.Entries) != 4 {
		t.Fatalf("entries = %d, want 4", len(session2.Entries))
	}

	// The original session1.Entries slice must be unaffected by the
	// incremental extension (no shared backing array mutation).
	if len(session1.Entries) != 2 {
		t.Fatalf("prior session1.Entries mutated in place: len=%d, want 2", len(session1.Entries))
	}
}

func TestParseFileCachedFallsBackOnTruncation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	full := testSessionHeader + testMessageLine(0) + testMessageLine(1)
	if err := os.WriteFile(path, []byte(full), 0644); err != nil {
		t.Fatal(err)
	}

	_, state1, err := parseFileCached(path, "--tmp--project--", "s.jsonl", nil)
	if err != nil {
		t.Fatalf("initial parse: %v", err)
	}

	truncated := testSessionHeader + testMessageLine(0)
	if err := os.WriteFile(path, []byte(truncated), 0644); err != nil {
		t.Fatal(err)
	}

	prior := &sessionCacheEntry{parse: state1}
	session2, _, err := parseFileCached(path, "--tmp--project--", "s.jsonl", prior)
	if err != nil {
		t.Fatalf("parse after truncation: %v", err)
	}
	if len(session2.Entries) != 2 {
		t.Fatalf("entries after truncation = %d, want 2 (must fall back to a full reparse)", len(session2.Entries))
	}
}

func TestParseFileCachedFallsBackOnHeaderMismatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(testSessionHeader+testMessageLine(0)), 0644); err != nil {
		t.Fatal(err)
	}

	_, state1, err := parseFileCached(path, "--tmp--project--", "s.jsonl", nil)
	if err != nil {
		t.Fatalf("initial parse: %v", err)
	}

	otherHeader := `{"type":"session","version":3,"id":"different-sid","timestamp":"2026-02-02T00:00:00Z","cwd":"/tmp/other"}` + "\n"
	replaced := otherHeader + testMessageLine(0) + testMessageLine(1)
	if err := os.WriteFile(path, []byte(replaced), 0644); err != nil {
		t.Fatal(err)
	}

	prior := &sessionCacheEntry{parse: state1}
	session2, _, err := parseFileCached(path, "--tmp--project--", "s.jsonl", prior)
	if err != nil {
		t.Fatalf("parse after replacement: %v", err)
	}
	if session2.SessionUUID != "different-sid" {
		t.Fatalf("SessionUUID = %q, want different-sid", session2.SessionUUID)
	}
	if len(session2.Entries) != 3 {
		t.Fatalf("entries = %d, want 3", len(session2.Entries))
	}
}

func TestParseFileCachedRandomizedAppends(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	dir := t.TempDir()
	path := filepath.Join(dir, "s.jsonl")
	if err := os.WriteFile(path, []byte(testSessionHeader), 0644); err != nil {
		t.Fatal(err)
	}

	var prior *sessionCacheEntry
	msgIdx := 0
	for round := 0; round < 30; round++ {
		batch := 1 + rng.Intn(3)
		var content string
		for i := 0; i < batch; i++ {
			content += testMessageLine(msgIdx)
			msgIdx++
		}
		appendToFile(t, path, content)

		session, state, err := parseFileCached(path, "--tmp--project--", "s.jsonl", prior)
		if err != nil {
			t.Fatalf("round %d: parseFileCached: %v", round, err)
		}
		want, err := ParseFile(path, "--tmp--project--", "s.jsonl")
		if err != nil {
			t.Fatalf("round %d: ParseFile: %v", round, err)
		}
		if !sessionsEqualIgnoringOrder(t, session, want) {
			t.Fatalf("round %d: incremental = %+v, want %+v", round, session, want)
		}
		prior = &sessionCacheEntry{session: session, parse: state}
	}
}
