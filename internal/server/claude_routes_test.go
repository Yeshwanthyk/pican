package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"pican/internal/claude"
	"pican/internal/runtimes"
	"pican/internal/sessions"
)

type testClaudeService struct {
	sessionsDir string
	calls       int
	cwd         string
	model       string
}

func (s *testClaudeService) StartSession(cwd, model string) (claude.Projection, error) {
	s.calls++
	s.cwd, s.model = cwd, model
	return claude.CreateSessionProjection(s.sessionsDir, cwd, model)
}

func TestNewSessionDispatchesClaudeCreationWithoutPiOrCodexFallback(t *testing.T) {
	sessionsDir := t.TempDir()
	cwd := t.TempDir()
	service := &testClaudeService{sessionsDir: sessionsDir}
	available := func(context.Context) runtimes.Availability { return runtimes.Availability{Available: true} }
	registry, err := runtimes.New(runtimes.Claude(runtimes.BuiltinOptions{
		Command: "claude", AvailabilityProbe: available, Catalog: compatibilityCatalog{},
		WorkerFactory: compatibilityWorkerFactory,
	}))
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		sessionsDir: sessionsDir, cache: sessions.NewCache(), runtimeRegistry: registry,
		defaultRuntime: "claude", claude: service,
	}
	body, _ := json.Marshal(map[string]string{"path": cwd, "runtime": "claude"})
	recorder := httptest.NewRecorder()
	s.handleNewSession(recorder, httptest.NewRequest(http.MethodPost, "/api/new-session", bytes.NewReader(body)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if service.calls != 1 || service.cwd != cwd || response.ID == "" {
		t.Fatalf("Claude dispatch = calls:%d cwd:%q id:%q", service.calls, service.cwd, response.ID)
	}
	resolved, err := sessions.ResolveByID(sessionsDir, response.ID)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := claude.ReadProjectionMetadata(resolved.Path)
	if err != nil || resolved.Session.Runtime != "claude" || !metadata.Fresh {
		t.Fatalf("created session = runtime:%q metadata:%+v err:%v", resolved.Session.Runtime, metadata, err)
	}
}
