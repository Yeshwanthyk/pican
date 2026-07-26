package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pican/internal/codex"
	"pican/internal/sessions"
	"pican/internal/workspace"
)

type fakeCodexService struct {
	root       string
	thread     codex.Thread
	started    bool
	renamed    string
	forkTurnID *string
	archived   string
	unarchived string
	deleted    string
}

func (f *fakeCodexService) materialize(thread codex.Thread) (codex.Projection, error) {
	f.thread = thread
	return codex.Materialize(f.root, thread)
}
func (f *fakeCodexService) StartSession(_ context.Context, cwd, model, effort string) (codex.Projection, error) {
	f.started = true
	return codex.Materialize(f.root, codex.Thread{ID: "started", CWD: cwd, Model: model, Effort: effort, CreatedAt: 1})
}
func (f *fakeCodexService) RenameSession(_ context.Context, nativeID, name string) (codex.Projection, error) {
	f.renamed = name
	thread := f.thread
	thread.ID = nativeID
	thread.Name = name
	return f.materialize(thread)
}
func (f *fakeCodexService) ForkSession(_ context.Context, _ string, turnID *string) (codex.Projection, error) {
	f.forkTurnID = turnID
	return f.materialize(codex.Thread{ID: "forked", CWD: f.thread.CWD, CreatedAt: 2})
}
func (f *fakeCodexService) RefreshThread(context.Context, string) (codex.Projection, error) {
	return f.materialize(f.thread)
}
func (f *fakeCodexService) ArchiveSession(_ context.Context, nativeID string) error {
	f.archived = nativeID
	path, _ := codex.ProjectionPath(f.root, f.thread)
	return codex.RemoveProjection(path, nativeID)
}
func (f *fakeCodexService) InspectArchivedThread(_ context.Context, nativeID string) (codex.Thread, error) {
	thread := f.thread
	thread.ID = nativeID
	return thread, nil
}
func (f *fakeCodexService) UnarchiveSession(_ context.Context, nativeID string) (codex.Projection, error) {
	f.unarchived = nativeID
	thread := f.thread
	thread.ID = nativeID
	return f.materialize(thread)
}
func (f *fakeCodexService) DeleteSession(_ context.Context, nativeID string) error {
	f.deleted = nativeID
	path, _ := codex.ProjectionPath(f.root, f.thread)
	return codex.RemoveProjection(path, nativeID)
}
func (f *fakeCodexService) ResolveTurnID(path, entryID string) (string, error) {
	return codex.ResolveTurnID(path, entryID)
}
func (f *fakeCodexService) LabelSessionEntry(path, entryID, label string, now func() time.Time) error {
	return codex.LabelSessionEntry(path, entryID, label, now)
}
func (f *fakeCodexService) AutoTitleSession(path, name string, now func() time.Time) error {
	return codex.AutoTitleSession(path, name, now)
}

func newCodexRouteServer(t *testing.T) (*Server, *fakeCodexService, string, string) {
	t.Helper()
	root := t.TempDir()
	cwd := t.TempDir()
	itemRaw := map[string]json.RawMessage{"content": json.RawMessage(`[{"type":"text","text":"hello"}]`)}
	thread := codex.Thread{ID: "native", CWD: cwd, Name: "Codex", CreatedAt: 1, Turns: []codex.Turn{{ID: "turn-1", Items: []codex.ThreadItem{{ID: "item-1", Type: "userMessage", Raw: itemRaw}}}}}
	fake := &fakeCodexService{root: root, thread: thread}
	projection, err := fake.materialize(thread)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := sessions.ParseFile(projection.Path, "project", projection.ID)
	if err != nil {
		t.Fatal(err)
	}
	entryID, _ := parsed.Entries[1]["id"].(string)
	registry, err := serverRuntimeRegistry(Deps{
		EnabledRuntimes:  []string{"pi", "codex"},
		RuntimeAvailable: func(string) (bool, string) { return true, "" },
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		sessionsDir:     root,
		cache:           sessions.NewCache(),
		codex:           fake,
		defaultRuntime:  "pi",
		runtimeRegistry: registry,
		now:             time.Now,
		modelsFor: func(context.Context, ModelQuery) (json.RawMessage, error) {
			return json.RawMessage(`{"models":[{"provider":"openai-codex","id":"gpt"}]}`), nil
		},
	}
	return s, fake, projection.ID, entryID
}

func TestCodexSessionRenameForkCloneAndRuntimeRoutes(t *testing.T) {
	s, fake, sessionID, entryID := newCodexRouteServer(t)

	newReq := httptest.NewRequest(http.MethodPost, "/api/new-session", strings.NewReader(`{"path":"`+t.TempDir()+`","runtime":"codex"}`))
	newRec := httptest.NewRecorder()
	s.handleNewSession(newRec, newReq)
	if newRec.Code != http.StatusOK || !fake.started {
		t.Fatalf("new session = %d %s", newRec.Code, newRec.Body.String())
	}

	renameReq := httptest.NewRequest(http.MethodPost, "/api/rename-session?id="+sessionID, strings.NewReader(`{"name":"Renamed"}`))
	renameRec := httptest.NewRecorder()
	s.handleRenameSession(renameRec, renameReq)
	if renameRec.Code != http.StatusOK || fake.renamed != "Renamed" {
		t.Fatalf("rename = %d %s", renameRec.Code, renameRec.Body.String())
	}

	// Restore the original projection for branch route resolution.
	projection, err := fake.materialize(codex.Thread{ID: "native", CWD: fake.thread.CWD, CreatedAt: 1, Turns: []codex.Turn{{ID: "turn-1", Items: []codex.ThreadItem{{ID: "item-1", Type: "userMessage", Raw: map[string]json.RawMessage{"content": json.RawMessage(`[{"type":"text","text":"hello"}]`)}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	s.cache = sessions.NewCache()

	forkReq := httptest.NewRequest(http.MethodPost, "/api/fork-session?id="+projection.ID, strings.NewReader(`{"entryId":"`+entryID+`"}`))
	forkRec := httptest.NewRecorder()
	s.handleApiForkSession(forkRec, forkReq)
	if forkRec.Code != http.StatusOK || fake.forkTurnID == nil || *fake.forkTurnID != "turn-1" {
		t.Fatalf("fork = %d %s turn=%v", forkRec.Code, forkRec.Body.String(), fake.forkTurnID)
	}

	fake.thread = codex.Thread{ID: "native", CWD: fake.thread.CWD, CreatedAt: 1}
	projection, _ = fake.materialize(fake.thread)
	s.cache = sessions.NewCache()
	cloneReq := httptest.NewRequest(http.MethodPost, "/api/clone-session?id="+projection.ID, strings.NewReader(`{}`))
	cloneRec := httptest.NewRecorder()
	s.handleApiCloneSession(cloneRec, cloneReq)
	if cloneRec.Code != http.StatusOK || fake.forkTurnID != nil {
		t.Fatalf("clone = %d %s turn=%v", cloneRec.Code, cloneRec.Body.String(), fake.forkTurnID)
	}

	runtimeRec := httptest.NewRecorder()
	s.handleRuntimes(runtimeRec, httptest.NewRequest(http.MethodGet, "/api/runtimes", nil))
	if runtimeRec.Code != http.StatusOK || !strings.Contains(runtimeRec.Body.String(), `"codex"`) {
		t.Fatalf("runtimes = %d %s", runtimeRec.Code, runtimeRec.Body.String())
	}
	modelsRec := httptest.NewRecorder()
	s.handleAvailableModels(modelsRec, httptest.NewRequest(http.MethodGet, "/api/models?runtime=codex", nil))
	if modelsRec.Code != http.StatusOK || !strings.Contains(modelsRec.Body.String(), codex.Provider) {
		t.Fatalf("models = %d %s", modelsRec.Code, modelsRec.Body.String())
	}
}

func TestCodexNativeLifecycleRoutes(t *testing.T) {
	s, fake, sessionID, _ := newCodexRouteServer(t)
	archive := httptest.NewRecorder()
	s.handleCodexThreadArchive(archive, httptest.NewRequest(http.MethodPost, "/api/codex/thread/archive?id="+sessionID, nil))
	if archive.Code != http.StatusOK || fake.archived != "native" {
		t.Fatalf("archive = %d %s", archive.Code, archive.Body.String())
	}
	if _, err := os.Stat(filepath.Join(fake.root, sessions.EncodeProjectName(fake.thread.CWD), sessionID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("projection still exists: %v", err)
	}

	unarchive := httptest.NewRecorder()
	s.handleCodexThreadUnarchive(unarchive, httptest.NewRequest(http.MethodPost, "/api/codex/thread/unarchive", strings.NewReader(`{"nativeId":"native"}`)))
	if unarchive.Code != http.StatusOK || fake.unarchived != "native" || !strings.Contains(unarchive.Body.String(), sessionID) {
		t.Fatalf("unarchive = %d %s", unarchive.Code, unarchive.Body.String())
	}

	deleteRec := httptest.NewRecorder()
	s.handleCodexThreadDelete(deleteRec, httptest.NewRequest(http.MethodPost, "/api/codex/thread/delete?id="+sessionID, nil))
	if deleteRec.Code != http.StatusOK || fake.deleted != "native" {
		t.Fatalf("delete = %d %s", deleteRec.Code, deleteRec.Body.String())
	}
}

func TestHostedCodexUnarchiveAuthorizesBeforeMutation(t *testing.T) {
	s, fake, _, _ := newCodexRouteServer(t)
	workspaceRoot := t.TempDir()
	resolver, err := workspace.New(workspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	s.workspace = resolver
	s.workspaceRoot = resolver.Root()
	s.hosted = true

	rec := httptest.NewRecorder()
	s.handleCodexThreadUnarchive(
		rec,
		httptest.NewRequest(
			http.MethodPost,
			"/api/codex/thread/unarchive",
			strings.NewReader(`{"nativeId":"native"}`),
		),
	)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if fake.unarchived != "" {
		t.Fatalf("outside thread mutated before authorization: %q", fake.unarchived)
	}
}

func TestCodexUnavailableKeepsProjectionViewableButDisablesChat(t *testing.T) {
	s, _, sessionID, _ := newCodexRouteServer(t)
	registry, err := serverRuntimeRegistry(Deps{
		EnabledRuntimes: []string{"pi", "codex"},
		RuntimeAvailable: func(runtime string) (bool, string) {
			if runtime == "codex" {
				return false, "Codex runtime is unavailable"
			}
			return true, ""
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	s.runtimeRegistry = registry
	rec := httptest.NewRecorder()
	s.handleApiSession(rec, httptest.NewRequest(http.MethodGet, "/api/session?id="+sessionID, nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"chatAvailable":false`) || !strings.Contains(rec.Body.String(), "Codex runtime is unavailable") {
		t.Fatalf("session = %d %s", rec.Code, rec.Body.String())
	}
}
