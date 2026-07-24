package claude

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func nativeRecord(nativeID, cwd, text string) string {
	return `{"type":"user","parentUuid":null,"cwd":` + compactJSON(cwd) + `,"sessionId":"` + nativeID + `","version":"2.1.215","message":{"role":"user","content":` + compactJSON(text) + `},"uuid":"` + strings.TrimSuffix(nativeID, "0") + `1","timestamp":"2026-01-01T00:00:00Z"}` + "\n"
}

func writeNative(t *testing.T, home, project, nativeID, content string) string {
	t.Helper()
	dir := filepath.Join(home, "projects", project)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, nativeID+".jsonl")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCatalogPartialScanNeverPrunesAndCompleteScanDoes(t *testing.T) {
	const oldID = "00000000-0000-4000-8000-000000000040"
	const partialID = "00000000-0000-4000-8000-000000000050"
	home := t.TempDir()
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	oldNative := writeNative(t, home, "-tmp-project", oldID, nativeRecord(oldID, cwd, "old"))
	catalog, err := NewCatalog(home, sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	result, err := catalog.Sync(context.Background())
	if err != nil || !result.Complete || len(result.SessionIDs) != 1 {
		t.Fatalf("initial sync = %+v, %v", result, err)
	}
	oldProjections, err := FindProjections(sessionsDir)
	if err != nil || oldProjections[oldID] == "" {
		t.Fatalf("initial projections = %v, %v", oldProjections, err)
	}
	if err := os.Remove(oldNative); err != nil {
		t.Fatal(err)
	}
	writeNative(t, home, "-tmp-project", partialID, nativeRecord(partialID, cwd, "partial")+"{malformed complete line\n")
	result, err = catalog.Sync(context.Background())
	if err != nil || result.Complete {
		t.Fatalf("partial sync = %+v, %v", result, err)
	}
	projections, err := FindProjections(sessionsDir)
	if err != nil || projections[oldID] == "" || projections[partialID] == "" {
		t.Fatalf("partial sync pruned a projection: %v, %v", projections, err)
	}

	writeNative(t, home, "-tmp-project", partialID, nativeRecord(partialID, cwd, "complete"))
	result, err = catalog.Sync(context.Background())
	if err != nil || !result.Complete {
		t.Fatalf("complete recovery sync = %+v, %v", result, err)
	}
	projections, err = FindProjections(sessionsDir)
	if err != nil || projections[oldID] != "" || projections[partialID] == "" {
		t.Fatalf("complete sync reconciliation = %v, %v", projections, err)
	}
}

func TestCatalogCompleteScanRetainsFreshCreationIntent(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000055"
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "projects"), 0o755); err != nil {
		t.Fatal(err)
	}
	sessionsDir := t.TempDir()
	projection, err := createSessionProjection(sessionsDir, nativeID, t.TempDir(), "haiku", time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := NewCatalog(home, sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	result, err := catalog.Sync(context.Background())
	if err != nil || !result.Complete {
		t.Fatalf("sync = %+v, %v", result, err)
	}
	metadata, err := ReadProjectionMetadata(projection.Path)
	if err != nil || !metadata.Fresh {
		t.Fatalf("fresh projection was pruned: metadata=%+v err=%v", metadata, err)
	}
}

func TestRefreshNativeWaitsForStableSnapshotBeforeRetiringPreview(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000056"
	const messageID = "msg-authoritative"
	home := t.TempDir()
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	assistant := `{"type":"assistant","parentUuid":"00000000-0000-4000-8000-000000000561","cwd":` + compactJSON(cwd) + `,"sessionId":"` + nativeID + `","version":"2.1.215","message":{"id":"` + messageID + `","role":"assistant","model":"haiku","content":[{"type":"text","text":"answer"}]},"uuid":"00000000-0000-4000-8000-000000000562","timestamp":"2026-01-01T00:00:01Z"}` + "\n"
	path := writeNative(t, home, "-tmp-refresh-stable", nativeID, nativeRecord(nativeID, cwd, "question")+assistant+`{"type":"mode","mode":"de`)
	catalog, err := NewCatalog(home, sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	projection, ready, err := catalog.RefreshNative(context.Background(), nativeID, messageID)
	if err != nil || ready || projection.ID == "" {
		t.Fatalf("incomplete refresh = projection:%+v ready:%v err:%v", projection, ready, err)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString(`fault"}` + "\n"); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	projection, ready, err = catalog.RefreshNative(context.Background(), nativeID, messageID)
	if err != nil || !ready || projection.ID == "" {
		t.Fatalf("stable refresh = projection:%+v ready:%v err:%v", projection, ready, err)
	}
}

func TestCatalogHomesAreIsolated(t *testing.T) {
	const firstID = "00000000-0000-4000-8000-000000000060"
	const secondID = "00000000-0000-4000-8000-000000000070"
	firstHome, secondHome := t.TempDir(), t.TempDir()
	firstSessions, secondSessions := t.TempDir(), t.TempDir()
	cwd := t.TempDir()
	writeNative(t, firstHome, "-tmp-first", firstID, nativeRecord(firstID, cwd, "first"))
	writeNative(t, secondHome, "-tmp-second", secondID, nativeRecord(secondID, cwd, "second"))
	firstCatalog, _ := NewCatalog(firstHome, firstSessions)
	secondCatalog, _ := NewCatalog(secondHome, secondSessions)
	first, firstErr := firstCatalog.Sync(context.Background())
	second, secondErr := secondCatalog.Sync(context.Background())
	if firstErr != nil || secondErr != nil || len(first.SessionIDs) != 1 || len(second.SessionIDs) != 1 || strings.Contains(first.SessionIDs[0], secondID) || strings.Contains(second.SessionIDs[0], firstID) {
		t.Fatalf("isolated syncs = first:%+v/%v second:%+v/%v", first, firstErr, second, secondErr)
	}
}

func TestWatcherRecoversAfterProjectsDirectoryRecreation(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000081"
	home := t.TempDir()
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	projectPath := filepath.Join(home, "projects", "-tmp-recreated")
	if err := os.MkdirAll(projectPath, 0o755); err != nil {
		t.Fatal(err)
	}
	catalog, err := NewCatalog(home, sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	errCh := make(chan error, 4)
	watcher, err := catalog.Watch(20*time.Millisecond, func(err error) { errCh <- err })
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()

	if err := os.RemoveAll(filepath.Join(home, "projects")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	writeNative(t, home, "-tmp-recreated", nativeID, nativeRecord(nativeID, cwd, "after recreation"))

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		projections, findErr := FindProjections(sessionsDir)
		if findErr == nil && projections[nativeID] != "" {
			return
		}
		select {
		case watchErr := <-errCh:
			t.Fatalf("watcher error: %v", watchErr)
		default:
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("Claude watcher did not recover after projects directory recreation")
}

func TestWatcherProjectsExternalSessionAppearance(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000080"
	home := t.TempDir()
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	catalog, err := NewCatalog(home, sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	errCh := make(chan error, 4)
	watcher, err := catalog.Watch(20*time.Millisecond, func(err error) { errCh <- err })
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	if err := os.Mkdir(filepath.Join(home, "projects"), 0o755); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	writeNative(t, home, "-tmp-watched", nativeID, nativeRecord(nativeID, cwd, "external"))
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		projections, findErr := FindProjections(sessionsDir)
		if findErr == nil && projections[nativeID] != "" {
			return
		}
		select {
		case watchErr := <-errCh:
			if !errors.Is(watchErr, os.ErrNotExist) {
				t.Fatalf("watcher error: %v", watchErr)
			}
		default:
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("external Claude session was not projected by watcher")
}
