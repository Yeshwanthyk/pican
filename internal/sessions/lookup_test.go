package sessions

import (
	"os"
	"path/filepath"
	"testing"
)

func writeSessionFile(t *testing.T, root, project, name string) string {
	t.Helper()
	dir := filepath.Join(root, project)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	content := `{"type":"session","version":3,"id":"sid","timestamp":"2026-05-06T00:00:00.000Z","cwd":"/tmp/project"}` + "\n" +
		`{"type":"message","id":"aaaaaaaa","parentId":null,"timestamp":"2026-05-06T00:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1778025601000}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestResolveSessionByIDReturnsKnownPath(t *testing.T) {
	root := t.TempDir()
	wantPath := writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	resolved, err := ResolveByID(root, "session.jsonl")
	if err != nil {
		t.Fatalf("ResolveByID returned error: %v", err)
	}
	if resolved.Session.ID != "session.jsonl" {
		t.Fatalf("ID = %q, want session.jsonl", resolved.Session.ID)
	}
	if resolved.Path != wantPath {
		t.Fatalf("Path = %q, want %q", resolved.Path, wantPath)
	}
}

func TestResolveSessionByIDRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	_, err := ResolveByID(root, "../session.jsonl")
	if err == nil {
		t.Fatalf("ResolveByID accepted traversal id")
	}
}

func TestResolveSessionByIDRejectsUnknown(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	_, err := ResolveByID(root, "missing.jsonl")
	if err == nil {
		t.Fatalf("ResolveByID accepted unknown id")
	}
}
