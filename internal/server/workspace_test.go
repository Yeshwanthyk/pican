package server

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"pican/internal/sessions"
	"pican/internal/workspace"
)

func TestResolveSessionCwdRejectsLegacyOutsideWorkspace(t *testing.T) {
	root := t.TempDir()
	workspaceRoot := filepath.Join(root, "workspace")
	outside := filepath.Join(root, "outside")
	sessionsDir := filepath.Join(root, "sessions")
	for _, path := range []string{workspaceRoot, outside, filepath.Join(sessionsDir, "project")} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	id := "legacy.jsonl"
	data := []byte(`{"type":"session","id":"legacy","cwd":"` + outside + `"}` + "\n")
	if err := os.WriteFile(filepath.Join(sessionsDir, "project", id), data, 0o600); err != nil {
		t.Fatal(err)
	}
	resolver, err := workspace.New(workspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{sessionsDir: sessionsDir, cache: sessions.NewCache(), workspace: resolver, workspaceRoot: resolver.Root(), hosted: true}
	if _, _, err := s.resolveSessionCwd(id); !errors.Is(err, errSessionOutsideWorkspace) {
		t.Fatalf("resolveSessionCwd error = %v, want workspace boundary error", err)
	}
}

func TestHostedDirectSessionSurfacesRejectOutsideWorkspace(t *testing.T) {
	root := t.TempDir()
	workspaceRoot := filepath.Join(root, "workspace")
	outside := filepath.Join(root, "outside")
	sessionsRoot := filepath.Join(root, "sessions")
	sessionProject := filepath.Join(sessionsRoot, "project")
	for _, path := range []string{workspaceRoot, outside, sessionProject} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	id := "outside.jsonl"
	if err := os.WriteFile(
		filepath.Join(sessionProject, id),
		[]byte(`{"type":"session","id":"outside","cwd":"`+outside+`"}`+"\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	resolver, err := workspace.New(workspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		sessionsDir:   sessionsRoot,
		cache:         sessions.NewCache(),
		workspace:     resolver,
		workspaceRoot: resolver.Root(),
		hosted:        true,
	}

	api := httptest.NewRecorder()
	s.handleApiSession(api, httptest.NewRequest(http.MethodGet, "/api/session?id="+id, nil))
	if api.Code != http.StatusBadRequest {
		t.Fatalf("direct API status = %d, want 400: %s", api.Code, api.Body.String())
	}
	if bootstrap := s.sessionBootstrap(id); bootstrap != "" {
		t.Fatalf("outside bootstrap = %q, want empty", bootstrap)
	}
}

func TestHostedGitfileOutsideWorkspaceIsRejected(t *testing.T) {
	root := t.TempDir()
	workspaceRoot := filepath.Join(root, "workspace")
	project := filepath.Join(workspaceRoot, "project")
	outsideGit := filepath.Join(root, "outside.git")
	for _, path := range []string{project, outsideGit} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(project, ".git"), []byte("gitdir: "+outsideGit+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolver, err := workspace.New(workspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{workspace: resolver, workspaceRoot: resolver.Root(), hosted: true}
	if err := s.validateGitBoundary(project); !errors.Is(err, errSessionOutsideWorkspace) {
		t.Fatalf("git boundary error = %v, want workspace rejection", err)
	}
}

func TestPrepareSessionPathUsesHostedCreationBoundary(t *testing.T) {
	root := t.TempDir()
	workspaceRoot := filepath.Join(root, "workspace")
	if err := os.MkdirAll(workspaceRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	resolver, err := workspace.New(workspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{workspace: resolver, workspaceRoot: resolver.Root(), hosted: true}
	child := filepath.Join(workspaceRoot, "missing", "child")
	got, err := s.prepareSessionPath(child)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.EvalSymlinks(child)
	if got != want {
		t.Fatalf("prepareSessionPath = %q, want %q", got, want)
	}
	sibling := filepath.Join(root, "sibling")
	if _, err := s.prepareSessionPath(sibling); !errors.Is(err, workspace.ErrOutsideRoot) {
		t.Fatalf("sibling error = %v, want ErrOutsideRoot", err)
	}
}
