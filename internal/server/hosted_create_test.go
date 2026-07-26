package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"pican/internal/auth"
	"pican/internal/chat"
	"pican/internal/codex"
	"pican/internal/sessions"
)

type countedCodexService struct {
	*fakeCodexService
	mu        sync.Mutex
	startOnce sync.Once
	started   chan struct{}
	release   chan struct{}
	calls     int
}

func (s *countedCodexService) StartSession(ctx context.Context, cwd, model, effort string) (codex.Projection, error) {
	s.mu.Lock()
	s.calls++
	s.mu.Unlock()
	if s.started != nil {
		s.startOnce.Do(func() { close(s.started) })
	}
	if s.release != nil {
		select {
		case <-ctx.Done():
			return codex.Projection{}, ctx.Err()
		case <-s.release:
		}
	}
	return s.fakeCodexService.StartSession(ctx, cwd, model, effort)
}

func (s *countedCodexService) startCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

type countedPromptSender struct {
	*fakeSender
	mu    sync.Mutex
	calls int
	err   error
}

func (s *countedPromptSender) Send(ctx context.Context, sessionID, sessionPath string, request chat.Request) error {
	s.mu.Lock()
	s.calls++
	err := s.err
	s.mu.Unlock()
	if err != nil {
		return err
	}
	return s.fakeSender.Send(ctx, sessionID, sessionPath, request)
}

func (s *countedPromptSender) sendCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func newHostedCreateServer(t *testing.T, promptErr error) (*Server, *countedCodexService, *countedPromptSender, string) {
	t.Helper()
	workspaceRoot := filepath.Join(t.TempDir(), "workspace")
	stateRoot := filepath.Join(workspaceRoot, ".pican")
	sessionsRoot := filepath.Join(stateRoot, "sessions")
	for _, path := range []string{workspaceRoot, sessionsRoot} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	base := &fakeCodexService{root: sessionsRoot}
	codexService := &countedCodexService{fakeCodexService: base}
	sender := &countedPromptSender{fakeSender: &fakeSender{}, err: promptErr}
	srv, err := New(Deps{
		AgentDir:            stateRoot,
		SessionsDir:         sessionsRoot,
		Hosted:              true,
		WorkspaceRoot:       workspaceRoot,
		Auth:                auth.New(""),
		ChatSender:          sender,
		Cache:               sessions.NewCache(),
		RenderExportSession: func(s sessions.Session, theme string) string { return "" },
		EnabledRuntimes:     []string{"codex"},
		RuntimeAvailable:    func(string) (bool, string) { return true, "" },
		Codex:               codexService,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(srv.Shutdown)
	return srv, codexService, sender, workspaceRoot
}

func hostedCreateRequest(t *testing.T, workspaceRoot, key, prompt string) *http.Request {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"path":          workspaceRoot,
		"runtime":       "codex",
		"initialPrompt": prompt,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/new-session", bytes.NewReader(body))
	request.Header.Set("Idempotency-Key", key)
	return request
}

func decodeCreateIdentity(t *testing.T, recorder *httptest.ResponseRecorder) (string, string, string) {
	t.Helper()
	var response struct {
		ID                  string `json:"id"`
		NativeID            string `json:"nativeId"`
		PromptDispatchState string `json:"promptDispatchState"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response %q: %v", recorder.Body.String(), err)
	}
	return response.ID, response.NativeID, response.PromptDispatchState
}

func TestIdempotentCreateReplaysIdentityAndRejectsConflict(t *testing.T) {
	srv, codexService, sender, workspaceRoot := newHostedCreateServer(t, nil)

	first := httptest.NewRecorder()
	srv.handleNewSession(first, hostedCreateRequest(t, workspaceRoot, "scotty-outer-1", "start here"))
	if first.Code != http.StatusOK {
		t.Fatalf("first create = %d %s", first.Code, first.Body.String())
	}
	firstID, firstNativeID, firstPromptState := decodeCreateIdentity(t, first)
	if firstID == "" || firstNativeID == "" || firstPromptState != "accepted" {
		t.Fatalf("first identity = %q %q state=%q", firstID, firstNativeID, firstPromptState)
	}

	replay := httptest.NewRecorder()
	srv.handleNewSession(replay, hostedCreateRequest(t, workspaceRoot, "scotty-outer-1", "start here"))
	if replay.Code != http.StatusOK {
		t.Fatalf("replay = %d %s", replay.Code, replay.Body.String())
	}
	replayID, replayNativeID, replayPromptState := decodeCreateIdentity(t, replay)
	if replayID != firstID || replayNativeID != firstNativeID || replayPromptState != "accepted" {
		t.Fatalf("replay identity = %q %q state=%q", replayID, replayNativeID, replayPromptState)
	}
	if got := codexService.startCalls(); got != 1 {
		t.Fatalf("Codex starts = %d, want 1", got)
	}
	if got := sender.sendCalls(); got != 1 {
		t.Fatalf("prompt sends = %d, want 1", got)
	}

	conflict := httptest.NewRecorder()
	srv.handleNewSession(conflict, hostedCreateRequest(t, workspaceRoot, "scotty-outer-1", "different"))
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict = %d %s", conflict.Code, conflict.Body.String())
	}
}

func TestConcurrentIdempotentCreatesConvergeOnOneThreadAndPrompt(t *testing.T) {
	srv, codexService, sender, workspaceRoot := newHostedCreateServer(t, nil)
	codexService.started = make(chan struct{})
	codexService.release = make(chan struct{})

	const callers = 16
	recorders := make([]*httptest.ResponseRecorder, callers)
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			recorder := httptest.NewRecorder()
			recorders[index] = recorder
			srv.handleNewSession(recorder, hostedCreateRequest(t, workspaceRoot, "scotty-concurrent", "one prompt"))
		}(i)
	}
	<-codexService.started
	close(codexService.release)
	wg.Wait()

	var stableID, stableNativeID string
	for i, recorder := range recorders {
		if recorder.Code != http.StatusOK {
			t.Fatalf("create %d = %d %s", i, recorder.Code, recorder.Body.String())
		}
		id, nativeID, _ := decodeCreateIdentity(t, recorder)
		if i == 0 {
			stableID, stableNativeID = id, nativeID
		} else if id != stableID || nativeID != stableNativeID {
			t.Fatalf("create %d identity = %q %q, want %q %q", i, id, nativeID, stableID, stableNativeID)
		}
	}
	if got := codexService.startCalls(); got != 1 {
		t.Fatalf("Codex starts = %d, want 1", got)
	}
	if got := sender.sendCalls(); got != 1 {
		t.Fatalf("prompt sends = %d, want 1", got)
	}
}

func TestAmbiguousPromptDispatchIsNeverRetried(t *testing.T) {
	srv, codexService, sender, workspaceRoot := newHostedCreateServer(t, errors.New("synthetic ambiguous dispatch"))

	first := httptest.NewRecorder()
	srv.handleNewSession(first, hostedCreateRequest(t, workspaceRoot, "scotty-ambiguous", "one prompt"))
	if first.Code != http.StatusAccepted {
		t.Fatalf("first create = %d %s", first.Code, first.Body.String())
	}
	id, nativeID, state := decodeCreateIdentity(t, first)
	if id == "" || nativeID == "" || state != "unknown" {
		t.Fatalf("ambiguous identity = %q %q state=%q", id, nativeID, state)
	}

	replay := httptest.NewRecorder()
	srv.handleNewSession(replay, hostedCreateRequest(t, workspaceRoot, "scotty-ambiguous", "one prompt"))
	if replay.Code != http.StatusAccepted {
		t.Fatalf("replay = %d %s", replay.Code, replay.Body.String())
	}
	if got := codexService.startCalls(); got != 1 {
		t.Fatalf("Codex starts = %d, want 1", got)
	}
	if got := sender.sendCalls(); got != 1 {
		t.Fatalf("prompt sends = %d, want 1", got)
	}
}
