package server

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestSubagentScanCacheReusesResultOnUnchangedFile is a regression test for
// the zero-caching bug: scanning the same unchanged parent file twice must
// only actually read it once.
func TestSubagentScanCacheReusesResultOnUnchangedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "parent.jsonl")
	if err := os.WriteFile(path, []byte("irrelevant"), 0o644); err != nil {
		t.Fatal(err)
	}

	cache := newSubagentScanCache()
	scans := 0
	scan := func() []subagentSummary {
		scans++
		return []subagentSummary{{ID: "sa-1", Title: "Fixed"}}
	}

	first := cache.parentRecords(path, scan)
	second := cache.parentRecords(path, scan)

	if scans != 1 {
		t.Fatalf("scan ran %d times, want 1 (second call should hit the cache)", scans)
	}
	if len(first) != 1 || len(second) != 1 || first[0].ID != "sa-1" || second[0].ID != "sa-1" {
		t.Fatalf("unexpected records: first=%+v second=%+v", first, second)
	}

	// The cache must hand back independent copies: mutating one result must
	// not corrupt the other or the cached entry itself.
	first[0].Title = "mutated"
	third := cache.parentRecords(path, scan)
	if scans != 1 {
		t.Fatalf("scan ran %d times after mutation, want still 1", scans)
	}
	if third[0].Title != "Fixed" {
		t.Fatalf("cached entry was corrupted by a caller mutation: %+v", third[0])
	}
}

// TestSubagentScanCacheInvalidatesOnFileChange is a regression test for the
// other half of caching: once the file's mtime/size change, the cache must
// re-scan rather than serve stale data forever.
func TestSubagentScanCacheInvalidatesOnFileChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "parent.jsonl")
	if err := os.WriteFile(path, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	cache := newSubagentScanCache()
	scans := 0
	scan := func() []subagentSummary {
		scans++
		return []subagentSummary{{ID: fmt.Sprintf("sa-%d", scans)}}
	}

	first := cache.parentRecords(path, scan)
	if scans != 1 || first[0].ID != "sa-1" {
		t.Fatalf("first scan: scans=%d records=%+v", scans, first)
	}

	// Change size AND force a distinct mtime so the change is observable
	// regardless of filesystem mtime resolution.
	if err := os.WriteFile(path, []byte("v1-plus-more-content"), 0o644); err != nil {
		t.Fatal(err)
	}
	newTime := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, newTime, newTime); err != nil {
		t.Fatal(err)
	}

	second := cache.parentRecords(path, scan)
	if scans != 2 || second[0].ID != "sa-2" {
		t.Fatalf("expected re-scan after file change: scans=%d records=%+v", scans, second)
	}
}

// TestSubagentScanCacheHeaderTimeReusesAndInvalidates covers the child
// header-time cache the same way as parentRecords above.
func TestSubagentScanCacheHeaderTimeReusesAndInvalidates(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "child.jsonl")
	if err := os.WriteFile(path, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	cache := newSubagentScanCache()
	scans := 0
	fixed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	scan := func() time.Time {
		scans++
		return fixed
	}

	if got := cache.headerTime(path, scan); scans != 1 || !got.Equal(fixed) {
		t.Fatalf("first call: scans=%d got=%v", scans, got)
	}
	if got := cache.headerTime(path, scan); scans != 1 || !got.Equal(fixed) {
		t.Fatalf("cache hit expected: scans=%d got=%v", scans, got)
	}

	if err := os.WriteFile(path, []byte("v1-plus-more"), 0o644); err != nil {
		t.Fatal(err)
	}
	newTime := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, newTime, newTime); err != nil {
		t.Fatal(err)
	}
	if got := cache.headerTime(path, scan); scans != 2 || !got.Equal(fixed) {
		t.Fatalf("expected re-scan after file change: scans=%d got=%v", scans, got)
	}
}

// TestHandleApiSubagentsPicksUpAppendedResultAfterCacheInvalidation is an
// end-to-end regression test: the mtime-keyed cache must not paper over a
// subagent's status changing (spawned -> done) once the parent session file
// is appended to.
func TestHandleApiSubagentsPicksUpAppendedResultAfterCacheInvalidation(t *testing.T) {
	s := newTestServer(t, func() time.Time { return time.Date(2026, 7, 17, 13, 0, 0, 0, time.UTC) })
	project := filepath.Join(t.TempDir(), "project")
	spawnOnly := fmt.Sprintf(
		"{\"type\":\"session\",\"timestamp\":\"2026-07-17T12:00:00Z\",\"cwd\":%q}\n"+
			"{\"type\":\"message\",\"timestamp\":\"2026-07-17T12:01:00Z\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"subagent_spawn\",\"details\":{\"id\":\"sa-1\",\"title\":\"Task\",\"harness\":\"pi\"}}}\n",
		project,
	)
	writeSubagentSession(t, s.sessionsDir, project, "parent.jsonl", spawnOnly)

	items := fetchSubagents(t, s)
	if len(items) != 1 || items[0].Status != "unknown" {
		t.Fatalf("before result: %+v", items)
	}

	path := filepath.Join(s.sessionsDir, filepath.Base(project), "parent.jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(
		"{\"type\":\"custom_message\",\"timestamp\":\"2026-07-17T12:02:00Z\",\"customType\":\"subagent-result\",\"details\":{\"id\":\"sa-1\",\"status\":\"done\"}}\n",
	); err != nil {
		t.Fatal(err)
	}
	f.Close()
	// Force a distinct mtime regardless of filesystem timestamp resolution.
	newTime := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, newTime, newTime); err != nil {
		t.Fatal(err)
	}

	items = fetchSubagents(t, s)
	if len(items) != 1 || items[0].Status != "done" {
		t.Fatalf("after appended result, expected status=done: %+v", items)
	}
}
