package projections

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pican/internal/sessions"
)

func replacementEntries(runtime, nativeID, cwd, text string) []map[string]any {
	return []map[string]any{
		{"type": "session", "version": 3, "id": runtime + "-" + nativeID, "runtime": runtime, "nativeId": nativeID, "cwd": cwd},
		{"type": "message", "id": "message", "parentId": nil, "timestamp": "2026-01-01T00:00:00Z", "message": map[string]any{"role": "assistant", "content": text}},
	}
}

func TestStorePathCanonicalizesCWDAndRejectsUnsafeIdentity(t *testing.T) {
	root := t.TempDir()
	store, err := NewStore(root, "claude")
	if err != nil {
		t.Fatal(err)
	}
	realProject := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(realProject, 0755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "project-link")
	if err := os.Symlink(realProject, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	path, err := store.Path("native-1", alias)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, sessions.EncodeProjectName(CanonicalCWD(realProject)), "claude-native-1.jsonl")
	if path != want {
		t.Fatalf("path = %q, want %q", path, want)
	}
	for _, nativeID := range []string{"", ".", "..", "a/b", `a\b`} {
		if _, err := store.Path(nativeID, realProject); err == nil {
			t.Errorf("native id %q was accepted", nativeID)
		}
	}
	if _, err := NewStore(root, "Claude"); err == nil {
		t.Fatal("invalid runtime ID was accepted")
	}
}

func TestStoreReplaceCreatesMissingSessionsDirectory(t *testing.T) {
	root := filepath.Join(t.TempDir(), "sessions")
	store, err := NewStore(root, "claude")
	if err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	projection, err := store.Replace("native", cwd, func([]string) ([]map[string]any, error) {
		return replacementEntries("claude", "native", CanonicalCWD(cwd), "new"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(projection.Path); err != nil {
		t.Fatalf("projection was not created: %v", err)
	}
}

func TestWriteJSONLAtomicUsesFingerprintCacheAndDetectsExternalChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "projection.jsonl")
	entries := replacementEntries("claude", "native", "/tmp/project", "new")
	if err := WriteJSONLAtomic(path, entries); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := projectionFingerprints.get(path); !ok {
		t.Fatal("new projection did not warm the fingerprint cache")
	}

	if err := WriteJSONLAtomic(path, entries); err != nil {
		t.Fatalf("cached identical write failed: %v", err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("cached identical write changed modtime: before=%v after=%v", before.ModTime(), after.ModTime())
	}

	external := []byte(strings.Replace(string(original), `"content":"new"`, `"content":"old"`, 1))
	if len(external) != len(original) {
		t.Fatal("test fixture must preserve projection size")
	}
	if err := os.WriteFile(path, external, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, before.ModTime(), before.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSONLAtomic(path, entries); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(original) {
		t.Fatalf("external projection change was hidden by fingerprint cache:\n%s", restored)
	}
}

func TestFingerprintCacheIsBounded(t *testing.T) {
	var cache fingerprintCache
	for i := 0; i <= maxProjectionFingerprints; i++ {
		cache.put(fmt.Sprintf("/projection/%d", i), projectionFingerprint{})
	}
	if got := cache.order.Len(); got != maxProjectionFingerprints {
		t.Fatalf("fingerprint cache entries = %d, want %d", got, maxProjectionFingerprints)
	}
	if _, ok := cache.get("/projection/0"); ok {
		t.Fatal("oldest fingerprint survived capacity eviction")
	}
	if _, ok := cache.get(fmt.Sprintf("/projection/%d", maxProjectionFingerprints)); !ok {
		t.Fatal("newest fingerprint was evicted")
	}
}

func TestStoreReplacePreservesLocalMetadataAndMigratesValidatedDuplicate(t *testing.T) {
	root := t.TempDir()
	store, err := NewStore(root, "claude")
	if err != nil {
		t.Fatal(err)
	}
	realProject := filepath.Join(t.TempDir(), "project")
	if err := os.Mkdir(realProject, 0755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "project-link")
	if err := os.Symlink(realProject, alias); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	oldPath := filepath.Join(root, sessions.EncodeProjectName(alias), "claude-native.jsonl")
	oldEntries := replacementEntries("claude", "native", alias, "old")
	oldEntries = append(oldEntries,
		map[string]any{"type": "session_info", "timestamp": "2026-01-01T00:00:01Z", "name": "Local"},
		map[string]any{"type": "label", "id": "label", "timestamp": "2026-01-01T00:00:02Z", "targetId": "message", "label": "keep"},
		map[string]any{"type": "model_change", "id": "model", "timestamp": "2026-01-01T00:00:03Z", "modelId": "sonnet"},
	)
	if err := WriteJSONLAtomic(oldPath, oldEntries); err != nil {
		t.Fatal(err)
	}

	canonical := CanonicalCWD(realProject)
	projection, err := store.Replace("native", canonical, func(existing []string) ([]map[string]any, error) {
		if len(existing) != 1 || existing[0] != oldPath {
			t.Fatalf("existing = %v, want old duplicate", existing)
		}
		return replacementEntries("claude", "native", canonical, "new"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old duplicate still exists: %v", err)
	}
	data, err := os.ReadFile(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{`"content":"new"`, `"name":"Local"`, `"label":"keep"`, `"modelId":"sonnet"`} {
		if !strings.Contains(string(data), expected) {
			t.Fatalf("replacement lost %s:\n%s", expected, data)
		}
	}
	found, err := store.Find()
	if err != nil || found["native"] != projection.Path {
		t.Fatalf("find = %v, err = %v", found, err)
	}
}

func TestStoreIdentityLockSerializesReplacementAcrossCWDKeys(t *testing.T) {
	root := t.TempDir()
	store, err := NewStore(root, "claude")
	if err != nil {
		t.Fatal(err)
	}
	oldCWD := filepath.Join(t.TempDir(), "old")
	newCWD := filepath.Join(t.TempDir(), "new")
	if err := os.MkdirAll(oldCWD, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(newCWD, 0755); err != nil {
		t.Fatal(err)
	}
	oldPath := filepath.Join(root, sessions.EncodeProjectName(oldCWD), "claude-native.jsonl")
	if err := WriteJSONLAtomic(oldPath, replacementEntries("claude", "native", oldCWD, "old")); err != nil {
		t.Fatal(err)
	}

	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		_, err := store.Replace("native", newCWD, func([]string) ([]map[string]any, error) {
			close(firstStarted)
			<-releaseFirst
			return replacementEntries("claude", "native", CanonicalCWD(newCWD), "new"), nil
		})
		firstDone <- err
	}()
	<-firstStarted

	secondCWD := filepath.Join(t.TempDir(), "newer")
	if err := os.MkdirAll(secondCWD, 0755); err != nil {
		t.Fatal(err)
	}
	secondStarted := make(chan struct{})
	secondDone := make(chan error, 1)
	go func() {
		_, err := store.Replace("native", secondCWD, func([]string) ([]map[string]any, error) {
			close(secondStarted)
			return replacementEntries("claude", "native", CanonicalCWD(secondCWD), "newest"), nil
		})
		secondDone <- err
	}()
	deadline := time.Now().Add(time.Second)
	for {
		identityLocks.mu.Lock()
		refs := identityLocks.locks[store.identityKey("native")].refs
		identityLocks.mu.Unlock()
		if refs == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second replacement never reached the identity lock")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-secondStarted:
		t.Fatal("second replacement entered while the same native identity was locked")
	default:
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	<-secondStarted
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}

	newPath, err := store.Path("native", secondCWD)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := sessions.ParseFile(newPath, sessions.EncodeProjectName(secondCWD), filepath.Base(newPath))
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Entries) < 2 || parsed.Entries[1]["message"].(map[string]any)["content"] != "newest" {
		t.Fatalf("final projection did not come from the serialized second replacement: %+v", parsed.Entries)
	}
}

func TestStoreRejectsMismatchedIdentityForReadRemoveAndReplacement(t *testing.T) {
	root := t.TempDir()
	store, err := NewStore(root, "claude")
	if err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	path, err := store.Path("filename-id", cwd)
	if err != nil {
		t.Fatal(err)
	}
	if err := WriteJSONLAtomic(path, replacementEntries("claude", "header-id", CanonicalCWD(cwd), "bad")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadMetadata(path); err == nil {
		t.Fatal("mismatched filename/header identity was accepted")
	}
	if err := store.Remove(path, "filename-id"); err == nil {
		t.Fatal("mismatched projection was removed")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("mismatched projection changed: %v", err)
	}
	if _, err := store.Replace("filename-id", cwd, func([]string) ([]map[string]any, error) {
		return replacementEntries("claude", "filename-id", CanonicalCWD(cwd), "replacement"), nil
	}); err == nil {
		t.Fatal("mismatched target projection was overwritten")
	}
	if _, err := store.Replace("new", cwd, func([]string) ([]map[string]any, error) {
		return replacementEntries("claude", "wrong", CanonicalCWD(cwd), "bad"), nil
	}); err == nil {
		t.Fatal("replacement with wrong identity was accepted")
	}
}
