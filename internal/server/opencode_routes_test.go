package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pican/internal/opencode"
	"pican/internal/runtimes"
	"pican/internal/sessions"
)

type fakeOpenCodeService struct {
	root     string
	cwd      string
	source   opencode.Projection
	started  bool
	renamed  string
	forkedAt string
	cloned   bool
	deleted  string
	model    string
}

func (f *fakeOpenCodeService) materialize(nativeID, title string, messages []opencode.Message) (opencode.Projection, error) {
	return opencode.Materialize(f.root, opencode.Session{
		ID: nativeID, Directory: f.cwd, Title: title,
		Time: opencode.SessionTime{Created: 1, Updated: 1},
	}, messages)
}

func (f *fakeOpenCodeService) StartSession(_ context.Context, cwd, model string) (opencode.Projection, error) {
	f.started = true
	f.cwd = cwd
	f.model = model
	projection, err := f.materialize("started", "Started", nil)
	if err == nil && model != "" {
		err = opencode.SetProjectionModel(projection.Path, model, nil)
	}
	return projection, err
}

func (f *fakeOpenCodeService) RenameSession(_ context.Context, nativeID, _ string, title string) (opencode.Projection, error) {
	f.renamed = title
	return f.materialize(nativeID, title, nil)
}

func (f *fakeOpenCodeService) ForkSession(_ context.Context, _ string, _ string, messageID string) (opencode.Projection, error) {
	f.forkedAt = messageID
	return f.materialize("forked", "Forked", nil)
}

func (f *fakeOpenCodeService) CloneSession(context.Context, string, string) (opencode.Projection, error) {
	f.cloned = true
	return f.materialize("cloned", "Cloned", nil)
}

func (f *fakeOpenCodeService) DeleteSession(_ context.Context, nativeID, _ string) error {
	f.deleted = nativeID
	return opencode.RemoveProjection(f.root, f.source.Path, nativeID)
}

func (f *fakeOpenCodeService) RefreshSession(context.Context, string, string) (opencode.Projection, error) {
	return f.source, nil
}

func (f *fakeOpenCodeService) AutoTitleSession(path, name string, now func() time.Time) error {
	return opencode.AutoTitleSession(path, name, now)
}

func newOpenCodeRouteServer(t *testing.T) (*Server, *fakeOpenCodeService, string, string) {
	t.Helper()
	root := t.TempDir()
	cwd := t.TempDir()
	message := opencode.Message{
		Info: opencode.MessageInfo{ID: "msg-user", SessionID: "native", Role: "user"},
		Parts: []opencode.Part{{
			ID: "part-user", SessionID: "native", MessageID: "msg-user",
			Type: "text", Text: "hello",
			Raw: json.RawMessage(`{"id":"part-user","sessionID":"native","messageID":"msg-user","type":"text","text":"hello"}`),
		}},
	}
	fake := &fakeOpenCodeService{root: root, cwd: cwd}
	projection, err := fake.materialize("native", "OpenCode", []opencode.Message{message})
	if err != nil {
		t.Fatal(err)
	}
	fake.source = projection
	parsed, err := sessions.ParseFile(projection.Path, "project", projection.ID)
	if err != nil {
		t.Fatal(err)
	}
	entryID, _ := parsed.Entries[1]["id"].(string)
	registry, err := serverRuntimeRegistry(Deps{
		EnabledRuntimes:  []string{string(runtimes.OpenCodeID)},
		RuntimeAvailable: func(string) (bool, string) { return true, "" },
	})
	if err != nil {
		t.Fatal(err)
	}
	return &Server{
		sessionsDir: root, cache: sessions.NewCache(), openCode: fake,
		defaultRuntime: string(runtimes.OpenCodeID), runtimeRegistry: registry, now: time.Now,
	}, fake, projection.ID, entryID
}

func TestOpenCodeSessionCreateRenameForkCloneAndDelete(t *testing.T) {
	s, fake, sessionID, entryID := newOpenCodeRouteServer(t)

	create := httptest.NewRecorder()
	s.handleNewSession(create, httptest.NewRequest(http.MethodPost, "/api/new-session",
		strings.NewReader(`{"path":"`+t.TempDir()+`","runtime":"opencode"}`)))
	if create.Code != http.StatusOK || !fake.started {
		t.Fatalf("create = %d %s", create.Code, create.Body.String())
	}

	rename := httptest.NewRecorder()
	s.handleRenameSession(rename, httptest.NewRequest(http.MethodPost, "/api/rename-session?id="+sessionID,
		strings.NewReader(`{"name":"Renamed"}`)))
	if rename.Code != http.StatusOK || fake.renamed != "Renamed" {
		t.Fatalf("rename = %d %s", rename.Code, rename.Body.String())
	}

	fake.source, _ = fake.materialize("native", "OpenCode", []opencode.Message{{
		Info:  opencode.MessageInfo{ID: "msg-user", SessionID: "native", Role: "user"},
		Parts: []opencode.Part{{ID: "part-user", SessionID: "native", MessageID: "msg-user", Type: "text", Text: "hello"}},
	}})
	s.cache = sessions.NewCache()
	fork := httptest.NewRecorder()
	s.handleApiForkSession(fork, httptest.NewRequest(http.MethodPost, "/api/fork-session?id="+fake.source.ID,
		strings.NewReader(`{"entryId":"`+entryID+`"}`)))
	if fork.Code != http.StatusOK || fake.forkedAt != "msg-user" {
		t.Fatalf("fork = %d %s boundary=%q", fork.Code, fork.Body.String(), fake.forkedAt)
	}

	fake.source, _ = fake.materialize("native", "OpenCode", nil)
	s.cache = sessions.NewCache()
	clone := httptest.NewRecorder()
	s.handleApiCloneSession(clone, httptest.NewRequest(http.MethodPost, "/api/clone-session?id="+fake.source.ID, strings.NewReader(`{}`)))
	if clone.Code != http.StatusOK || !fake.cloned {
		t.Fatalf("clone = %d %s", clone.Code, clone.Body.String())
	}

	fake.source, _ = fake.materialize("native", "OpenCode", nil)
	s.cache = sessions.NewCache()
	deleteRecorder := httptest.NewRecorder()
	s.handleOpenCodeSessionDelete(deleteRecorder, httptest.NewRequest(http.MethodPost, "/api/opencode/session/delete?id="+fake.source.ID, nil))
	if deleteRecorder.Code != http.StatusOK || fake.deleted != "native" {
		t.Fatalf("delete = %d %s", deleteRecorder.Code, deleteRecorder.Body.String())
	}
}

func TestOpenCodeUnsupportedReasoningFailsClosed(t *testing.T) {
	s, _, sessionID, _ := newOpenCodeRouteServer(t)
	recorder := httptest.NewRecorder()
	s.handleSetThinkingLevel(recorder, httptest.NewRequest(http.MethodPost, "/api/set-thinking-level?id="+sessionID,
		strings.NewReader(`{"level":"high"}`)))
	if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "does not support effort or reasoning selection") {
		t.Fatalf("reasoning = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestOpenCodeUnavailableKeepsProjectionViewableAndFailsChatClosed(t *testing.T) {
	s, _, sessionID, _ := newOpenCodeRouteServer(t)
	registration := s.runtimeRegistry.List()[0]
	registration.AvailabilityProbe = func(context.Context) runtimes.Availability {
		return runtimes.Availability{Available: false, Reason: "OpenCode child is restarting"}
	}
	registry, err := runtimes.New(registration)
	if err != nil {
		t.Fatal(err)
	}
	s.runtimeRegistry = registry

	session := httptest.NewRecorder()
	s.handleApiSession(session, httptest.NewRequest(http.MethodGet, "/api/session?id="+sessionID, nil))
	if session.Code != http.StatusOK ||
		!strings.Contains(session.Body.String(), `"chatAvailable":false`) ||
		!strings.Contains(session.Body.String(), "OpenCode child is restarting") {
		t.Fatalf("session = %d %s", session.Code, session.Body.String())
	}

	chat := httptest.NewRecorder()
	s.handleChat(chat, httptest.NewRequest(
		http.MethodPost,
		"/api/chat?id="+sessionID,
		strings.NewReader(`{"message":"hello"}`),
	))
	if chat.Code != http.StatusServiceUnavailable ||
		!strings.Contains(chat.Body.String(), "OpenCode child is restarting") {
		t.Fatalf("chat = %d %s", chat.Code, chat.Body.String())
	}
}

func TestOpenCodeBtwUsesNativeCreationAdapter(t *testing.T) {
	s, fake, _, _ := newOpenCodeRouteServer(t)
	s.db = newBtwDB(t)
	fake.started = false
	project := t.TempDir()

	response := httptest.NewRecorder()
	s.handleNewBtw(response, httptest.NewRequest(
		http.MethodPost,
		"/api/btw/new",
		strings.NewReader(`{"path":"`+project+`","parent":"parent"}`),
	))
	if response.Code != http.StatusOK || !fake.started || fake.cwd != project {
		t.Fatalf("btw = %d %s started=%v cwd=%q", response.Code, response.Body.String(), fake.started, fake.cwd)
	}
}
