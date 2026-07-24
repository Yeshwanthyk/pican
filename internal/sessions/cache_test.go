package sessions

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionCacheReusesParsedSessions(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")

	c := NewCache()

	first, err := c.LoadAll(root)
	if err != nil {
		t.Fatalf("first loadAll: %v", err)
	}
	if len(first) != 1 {
		t.Fatalf("first: got %d sessions, want 1", len(first))
	}
	if c.parses != 1 || c.hits != 0 {
		t.Fatalf("after first call: parses=%d hits=%d, want 1/0", c.parses, c.hits)
	}

	second, err := c.LoadAll(root)
	if err != nil {
		t.Fatalf("second loadAll: %v", err)
	}
	if len(second) != 1 {
		t.Fatalf("second: got %d sessions, want 1", len(second))
	}
	if c.parses != 1 {
		t.Fatalf("expected no additional parses on cached read, got parses=%d", c.parses)
	}
	if c.hits != 1 {
		t.Fatalf("expected 1 cache hit, got %d", c.hits)
	}
}

func TestParsedSessionCacheEvictsLeastRecentlyUsedUnderBytePressure(t *testing.T) {
	root := t.TempDir()
	firstPath := writeSessionFile(t, root, "--tmp--project--", "first.jsonl")
	writeSessionFile(t, root, "--tmp--project--", "second.jsonl")

	first, err := ParseFile(firstPath, "--tmp--project--", "first.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	budget := approximateSessionBytes(first) + 32
	c := NewCache(WithSessionCacheByteBudget(budget))

	if _, err := c.Resolve(root, "first.jsonl"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Resolve(root, "second.jsonl"); err != nil {
		t.Fatal(err)
	}
	stats := c.Stats()
	if stats.SessionEntries != 1 || stats.SessionEvictions != 1 {
		t.Fatalf("after pressure: stats = %#v", stats)
	}
	if stats.SessionBytes > budget {
		t.Fatalf("cache bytes = %d, budget = %d", stats.SessionBytes, budget)
	}

	if _, err := c.Resolve(root, "first.jsonl"); err != nil {
		t.Fatal(err)
	}
	stats = c.Stats()
	if stats.SessionParses != 3 {
		t.Fatalf("session parses = %d, want 3 after evicted access", stats.SessionParses)
	}
}

func TestResolveSummaryDoesNotPopulateFullSessionCache(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	c := NewCache()

	first, err := c.ResolveSummary(root, "session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.ResolveSummary(root, "session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID {
		t.Fatalf("summary ids differ: %q != %q", first.ID, second.ID)
	}
	stats := c.Stats()
	if stats.SummaryParses != 1 || stats.SummaryHits != 1 {
		t.Fatalf("summary stats = %#v", stats)
	}
	if stats.SessionParses != 0 || stats.SessionEntries != 0 {
		t.Fatalf("metadata-only resolve populated full cache: %#v", stats)
	}

	fullFirst := NewCache()
	if _, err := fullFirst.Resolve(root, "session.jsonl"); err != nil {
		t.Fatal(err)
	}
	if _, err := fullFirst.ResolveSummary(root, "session.jsonl"); err != nil {
		t.Fatal(err)
	}
	stats = fullFirst.Stats()
	if stats.SummaryParses != 0 || stats.SummaryHits != 1 {
		t.Fatalf("summary did not reuse parsed full session: %#v", stats)
	}
}

func TestSessionCacheInvalidateForcesResolveAtSameModTime(t *testing.T) {
	root := t.TempDir()
	path := writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	originalInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	c := NewCache()
	first, err := c.Resolve(root, "session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if first.Session.Name == "updated" {
		t.Fatal("unexpected initial title")
	}

	updated := `{"type":"session","id":"session","cwd":"/tmp/project","name":"updated"}` + "\n"
	if err := os.WriteFile(path, []byte(updated), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, originalInfo.ModTime(), originalInfo.ModTime()); err != nil {
		t.Fatal(err)
	}

	cached, err := c.Resolve(root, "session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if cached.Session.Name == "updated" {
		t.Fatal("same-modtime rewrite unexpectedly bypassed cache")
	}

	c.Invalidate("session.jsonl")
	refreshed, err := c.Resolve(root, "session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if refreshed.Session.Name != "updated" {
		t.Fatalf("name after invalidation = %q", refreshed.Session.Name)
	}
}

func TestSessionCacheReparsesOnModTimeChange(t *testing.T) {
	root := t.TempDir()
	path := writeSessionFile(t, root, "--tmp--project--", "session.jsonl")

	c := NewCache()
	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("first loadAll: %v", err)
	}

	// Bump modtime forward.
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("second loadAll: %v", err)
	}
	if c.parses != 2 {
		t.Fatalf("expected re-parse after modtime bump, got parses=%d", c.parses)
	}
	if c.hits != 0 {
		t.Fatalf("expected 0 hits when modtime changed, got %d", c.hits)
	}
}

func TestSessionCacheEvictsRemovedFiles(t *testing.T) {
	root := t.TempDir()
	path := writeSessionFile(t, root, "--tmp--project--", "session.jsonl")

	c := NewCache()
	if _, err := c.Resolve(root, "session.jsonl"); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if stats := c.Stats(); stats.SessionEntries != 1 {
		t.Fatalf("after resolve: stats = %#v", stats)
	}

	if err := os.Remove(path); err != nil {
		t.Fatalf("remove: %v", err)
	}

	got, err := c.LoadAll(root)
	if err != nil {
		t.Fatalf("after remove: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 sessions after deletion, got %d", len(got))
	}
	if len(c.entries) != 0 {
		t.Fatalf("expected cache to evict deleted file, size=%d", len(c.entries))
	}
	if stats := c.Stats(); stats.SessionEntries != 0 || stats.SessionBytes != 0 {
		t.Fatalf("expected parsed session eviction after deletion, stats=%#v", stats)
	}
}

func TestSessionCachePicksUpNewFiles(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "first.jsonl")

	c := NewCache()
	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("first loadAll: %v", err)
	}

	writeSessionFile(t, root, "--tmp--project--", "second.jsonl")

	got, err := c.LoadAll(root)
	if err != nil {
		t.Fatalf("second loadAll: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(got))
	}
	if c.parses != 2 {
		t.Fatalf("expected exactly one re-parse (for new file), got parses=%d", c.parses)
	}
	if c.hits != 1 {
		t.Fatalf("expected 1 hit (the unchanged first file), got %d", c.hits)
	}
}

func TestSessionCacheSkipsReadDirWhenDirsUnchanged(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")

	c := NewCache()
	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("first loadAll: %v", err)
	}
	readsAfterFirst := c.dirReads
	if readsAfterFirst == 0 {
		t.Fatalf("expected at least one ReadDir on the cold cache")
	}

	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("second loadAll: %v", err)
	}
	if c.dirReads != readsAfterFirst {
		t.Fatalf("expected no additional ReadDir calls when nothing changed, got %d (was %d)", c.dirReads, readsAfterFirst)
	}

	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("third loadAll: %v", err)
	}
	if c.dirReads != readsAfterFirst {
		t.Fatalf("expected ReadDir count to stay flat across repeated unchanged calls, got %d (was %d)", c.dirReads, readsAfterFirst)
	}
}

func TestSessionCacheDirWalkPicksUpNewFileWithoutStaleModTime(t *testing.T) {
	root := t.TempDir()
	path := writeSessionFile(t, root, "--tmp--project--", "session.jsonl")

	c := NewCache()
	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("first loadAll: %v", err)
	}

	// Append to the existing file: this does NOT change the parent
	// directory's modTime, so the cached name-listing must not be trusted to
	// also cache the file's modTime — LoadAll must still stat it freshly.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatalf("open for append: %v", err)
	}
	if _, err := f.WriteString(`{"type":"message","id":"m1","timestamp":"2026-01-01T00:00:01Z","message":{"role":"user","content":"hi"}}` + "\n"); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	// Ensure the mtime actually advances on filesystems with coarse timestamp
	// resolution.
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("second loadAll: %v", err)
	}
	if c.parses != 2 {
		t.Fatalf("expected the appended file to be re-parsed despite unchanged dir mtime, got parses=%d", c.parses)
	}

	// A genuinely new file added to the project dir changes the dir's own
	// modTime, so the cached name-listing must be refreshed to see it.
	writeSessionFile(t, root, "--tmp--project--", "second.jsonl")
	got, err := c.LoadAll(root)
	if err != nil {
		t.Fatalf("third loadAll: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions after adding a new file, got %d", len(got))
	}
}

func TestSessionCacheHandlesRenamedProjectDir(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")

	c := NewCache()
	if _, err := c.LoadAll(root); err != nil {
		t.Fatalf("first loadAll: %v", err)
	}

	oldDir := filepath.Join(root, "--tmp--project--")
	newDir := filepath.Join(root, "--tmp--project-renamed--")
	if err := os.Rename(oldDir, newDir); err != nil {
		t.Fatalf("rename: %v", err)
	}

	got, err := c.LoadAll(root)
	if err != nil {
		t.Fatalf("second loadAll: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 session under the renamed dir, got %d", len(got))
	}
	if _, ok := c.dirListings["--tmp--project--"]; ok {
		t.Fatalf("expected stale dirListing for the old project dir name to be pruned")
	}
	if _, ok := c.dirListings["--tmp--project-renamed--"]; !ok {
		t.Fatalf("expected a dirListing for the renamed project dir")
	}
}

func TestSessionCacheIgnoresNonJsonl(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "--tmp--project--")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}

	c := NewCache()
	got, err := c.LoadAll(root)
	if err != nil {
		t.Fatalf("loadAll: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(got))
	}
}
