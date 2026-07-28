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
	"testing"

	"pican/internal/auth"
	"pican/internal/codex"
	"pican/internal/runtimes"
	"pican/internal/sessioncreate"
	"pican/internal/sessions"
	"pican/internal/updater"
)

func TestHostedAndStandaloneRouteSurfaceMatrix(t *testing.T) {
	t.Run("hosted registers every retained route", func(t *testing.T) {
		s := &Server{hosted: true, auth: auth.New("")}
		mux := http.NewServeMux()
		s.Register(mux)

		for _, route := range routeSurfaceMatrix {
			if !route.Hosted {
				continue
			}
			assertRegisteredPattern(t, mux, route.Pattern)
		}
	})

	t.Run("hosted returns 404 for every standalone-only route", func(t *testing.T) {
		s := &Server{hosted: true, auth: auth.New("")}
		mux := http.NewServeMux()
		s.Register(mux)

		for _, route := range routeSurfaceMatrix {
			if route.Hosted || !route.Standalone {
				continue
			}
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, route.Pattern, nil))
			if recorder.Code != http.StatusNotFound {
				t.Errorf("GET %s = %d, want 404", route.Pattern, recorder.Code)
			}
		}
	})

	t.Run("standalone registers the complete route matrix", func(t *testing.T) {
		s := &Server{
			auth:    auth.New(""),
			push:    &PushManager{},
			updater: updater.New("dev"),
		}
		mux := http.NewServeMux()
		s.Register(mux)

		for _, route := range routeSurfaceMatrix {
			if !route.Standalone {
				continue
			}
			assertRegisteredPattern(t, mux, route.Pattern)
		}
	})
}

func assertRegisteredPattern(t *testing.T, mux *http.ServeMux, pattern string) {
	t.Helper()
	_, got := mux.Handler(httptest.NewRequest(http.MethodGet, pattern, nil))
	if got != pattern {
		t.Errorf("route %s resolved to pattern %q", pattern, got)
	}
}

func TestHostedAndStandaloneServiceSurfaceMatrix(t *testing.T) {
	t.Run("hosted constructs only retained services", func(t *testing.T) {
		s, _, _ := newHostedSurfaceServer(t, auth.New(""), true)
		want := serviceSurfaceFor(true)
		if s.services != want {
			t.Fatalf("hosted services = %+v, want %+v", s.services, want)
		}
		if s.db == nil || s.sessionCreates == nil {
			t.Fatal("hosted core SQLite/session-create services are absent")
		}
		if s.schedules != nil || s.push != nil || s.chatQueue != nil || s.queueDrainer != nil {
			t.Fatalf("hosted standalone services constructed: schedules=%v push=%v chatQueue=%v drainer=%v",
				s.schedules != nil, s.push != nil, s.chatQueue != nil, s.queueDrainer != nil)
		}
		if s.updater != nil || s.runInstall != nil || s.runRestart != nil {
			t.Fatal("hosted updater hooks were retained")
		}
		if !s.metrics.startedAt.IsZero() || s.metrics.cpuLast != nil {
			t.Fatal("hosted metrics state initialized")
		}
		if s.tasks.watcher != nil || s.tasks.targets != nil || s.tasks.watched != nil {
			t.Fatal("hosted tasks watcher initialized")
		}
		for _, table := range []string{
			"scratchpads", "settings", "project_prefs", "app_settings",
			"peer_hosts", "btw_sessions", "schedules", "schedule_runs",
			"chat_queue_items", "chat_queue_state",
		} {
			var count int
			err := s.db.QueryRow(
				"SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
				table,
			).Scan(&count)
			if err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Errorf("hosted constructed excluded table %q", table)
			}
		}
	})

	t.Run("standalone retains every existing service", func(t *testing.T) {
		dir := t.TempDir()
		hook := func(context.Context) error { return nil }
		s, err := New(Deps{
			AgentDir:    dir,
			SessionsDir: dir,
			Auth:        auth.New(""),
			Cache:       sessions.NewCache(),
			Updater:     updater.New("dev"),
			RunInstall:  hook,
			RunRestart:  func() error { return nil },
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(s.Shutdown)

		want := serviceSurfaceFor(false)
		if s.services != want {
			t.Fatalf("standalone services = %+v, want %+v", s.services, want)
		}
		if s.db == nil || s.sessionCreates == nil || s.schedules == nil || s.push == nil ||
			s.chatQueue == nil || s.queueDrainer == nil || s.updater == nil ||
			s.runInstall == nil || s.runRestart == nil {
			t.Fatal("standalone service construction regressed")
		}
		if s.metrics.startedAt.IsZero() || s.metrics.cpuLast == nil {
			t.Fatal("standalone metrics state is absent")
		}
		if s.tasks.watcher == nil || s.tasks.targets == nil || s.tasks.watched == nil {
			t.Fatal("standalone tasks watcher is absent")
		}
	})
}

type hostedSurfaceCodex struct {
	*fakeCodexService
	calls int
	cwd   string
}

func (f *hostedSurfaceCodex) StartSession(ctx context.Context, cwd, model, effort string) (codex.Projection, error) {
	f.calls++
	f.cwd = cwd
	return f.fakeCodexService.StartSession(ctx, cwd, model, effort)
}

func newHostedSurfaceServer(
	t *testing.T,
	middleware *auth.Middleware,
	withExcludedDeps bool,
) (*Server, *hostedSurfaceCodex, string) {
	t.Helper()
	parent := t.TempDir()
	workspaceRoot := filepath.Join(parent, "workspace")
	stateRoot := filepath.Join(workspaceRoot, ".pican")
	sessionsRoot := filepath.Join(stateRoot, "sessions")
	if err := os.MkdirAll(sessionsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	fake := &hostedSurfaceCodex{fakeCodexService: &fakeCodexService{root: sessionsRoot}}
	deps := Deps{
		AgentDir:        stateRoot,
		SessionsDir:     sessionsRoot,
		Hosted:          true,
		WorkspaceRoot:   workspaceRoot,
		Auth:            middleware,
		Cache:           sessions.NewCache(),
		EnabledRuntimes: []string{"codex"},
		RuntimeAvailable: func(string) (bool, string) {
			return true, ""
		},
		Codex: fake,
	}
	if withExcludedDeps {
		deps.Updater = updater.New("dev")
		deps.RunInstall = func(context.Context) error { return nil }
		deps.RunRestart = func() error { return nil }
		deps.Claude = &testClaudeService{}
		deps.OpenCode = &fakeOpenCodeService{}
	}
	s, err := New(deps)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Shutdown)
	return s, fake, s.workspaceRoot
}

func TestHostedCreateWorkspaceAndRuntimeMatrix(t *testing.T) {
	accepted := []struct {
		name string
		body func(root string) map[string]any
	}{
		{
			name: "omitted path and runtime",
			body: func(string) map[string]any { return map[string]any{} },
		},
		{
			name: "exact root and explicit Codex",
			body: func(root string) map[string]any {
				return map[string]any{"path": root, "runtime": "codex"}
			},
		},
	}
	for _, test := range accepted {
		t.Run("accepts "+test.name, func(t *testing.T) {
			s, fake, root := newHostedSurfaceServer(t, auth.New(""), false)
			recorder := serveHostedCreate(t, s, "accepted-"+test.name, test.body(root))
			if recorder.Code != http.StatusOK {
				t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
			}
			if fake.calls != 1 || fake.cwd != root {
				t.Fatalf("Codex StartSession calls=%d cwd=%q, want 1 and %q", fake.calls, fake.cwd, root)
			}
			var trackedTables int
			if err := s.db.QueryRow(
				"SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'project_prefs'",
			).Scan(&trackedTables); err != nil {
				t.Fatal(err)
			}
			if trackedTables != 0 {
				t.Fatal("hosted create constructed Projects persistence")
			}
		})
	}

	rejected := []struct {
		name  string
		setup func(t *testing.T, root string) string
		body  func(root, path string) map[string]any
	}{
		{
			name:  "existing child",
			setup: func(t *testing.T, root string) string { return mkdirTestPath(t, filepath.Join(root, "child")) },
			body:  pathBody,
		},
		{
			name:  "missing child",
			setup: func(_ *testing.T, root string) string { return filepath.Join(root, "missing") },
			body:  pathBody,
		},
		{
			name:  "parent",
			setup: func(_ *testing.T, root string) string { return filepath.Dir(root) },
			body:  pathBody,
		},
		{
			name: "sibling",
			setup: func(t *testing.T, root string) string {
				return mkdirTestPath(t, filepath.Join(filepath.Dir(root), "sibling"))
			},
			body: pathBody,
		},
		{
			name: "traversal",
			setup: func(_ *testing.T, root string) string {
				return root + string(filepath.Separator) + "child" + string(filepath.Separator) + ".."
			},
			body: pathBody,
		},
		{
			name: "symlink escape",
			setup: func(t *testing.T, root string) string {
				outside := mkdirTestPath(t, filepath.Join(filepath.Dir(root), "outside"))
				link := filepath.Join(root, "escape")
				if err := os.Symlink(outside, link); err != nil {
					t.Fatal(err)
				}
				return link
			},
			body: pathBody,
		},
		{
			name:  "source session",
			setup: func(_ *testing.T, root string) string { return root },
			body: func(root, _ string) map[string]any {
				return map[string]any{"path": root, "sourceSessionId": "source.jsonl"}
			},
		},
		{
			name:  "non Codex runtime",
			setup: func(_ *testing.T, root string) string { return root },
			body: func(root, _ string) map[string]any {
				return map[string]any{"path": root, "runtime": "pi"}
			},
		},
	}
	for _, test := range rejected {
		t.Run("rejects "+test.name, func(t *testing.T) {
			s, fake, root := newHostedSurfaceServer(t, auth.New(""), false)
			path := test.setup(t, root)
			key := "rejected-" + test.name
			recorder := serveHostedCreate(t, s, key, test.body(root, path))
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("create = %d %s, want 400", recorder.Code, recorder.Body.String())
			}
			if fake.calls != 0 {
				t.Fatalf("Codex StartSession called %d times", fake.calls)
			}
			if _, err := s.sessionCreates.Get(context.Background(), key); !errors.Is(err, sessioncreate.ErrRecordMissing) {
				t.Fatalf("idempotency state mutated before rejection: %v", err)
			}
		})
	}
}

func TestHostedServerRequiresCodexOnlyRuntimeAndService(t *testing.T) {
	tests := []struct {
		name string
		deps func(root, sessionsRoot string) Deps
	}{
		{
			name: "Pi runtime",
			deps: func(root, sessionsRoot string) Deps {
				return Deps{
					WorkspaceRoot: root,
					EnabledRuntimes: []string{
						string(runtimes.PiID),
					},
					Codex: &fakeCodexService{root: sessionsRoot},
				}
			},
		},
		{
			name: "mixed runtimes",
			deps: func(root, sessionsRoot string) Deps {
				return Deps{
					WorkspaceRoot:   root,
					EnabledRuntimes: []string{"codex", "pi"},
					Codex:           &fakeCodexService{root: sessionsRoot},
				}
			},
		},
		{
			name: "non Codex default",
			deps: func(root, sessionsRoot string) Deps {
				return Deps{
					WorkspaceRoot:   root,
					EnabledRuntimes: []string{"codex"},
					DefaultRuntime:  "pi",
					Codex:           &fakeCodexService{root: sessionsRoot},
				}
			},
		},
		{
			name: "missing Codex service",
			deps: func(root, _ string) Deps {
				return Deps{
					WorkspaceRoot:   root,
					EnabledRuntimes: []string{"codex"},
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "workspace")
			stateRoot := filepath.Join(root, ".pican")
			sessionsRoot := filepath.Join(stateRoot, "sessions")
			if err := os.MkdirAll(sessionsRoot, 0o755); err != nil {
				t.Fatal(err)
			}
			deps := test.deps(root, sessionsRoot)
			deps.AgentDir = stateRoot
			deps.SessionsDir = sessionsRoot
			deps.Hosted = true
			deps.Auth = auth.New("")
			deps.Cache = sessions.NewCache()
			if s, err := New(deps); err == nil {
				s.Shutdown()
				t.Fatal("hosted server accepted invalid runtime/service configuration")
			}
		})
	}
}

func TestHostedCancelRejectsOutsideWorkspaceBeforeAbort(t *testing.T) {
	s, _, _ := newHostedSurfaceServer(t, auth.New(""), false)
	outside := t.TempDir()
	projectDir := filepath.Join(s.sessionsDir, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionID := "outside.jsonl"
	content := `{"type":"session","version":3,"id":"native-outside","timestamp":"2026-05-06T00:00:00.000Z","cwd":` +
		jsonString(outside) + `,"runtime":"codex","nativeId":"native-outside"}` + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, sessionID), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	sender := &existingAbortSender{fakeSender: &fakeSender{}, exists: true}
	s.chatSender = sender

	recorder := httptest.NewRecorder()
	s.handleCancelChat(
		recorder,
		httptest.NewRequest(http.MethodPost, "/api/chat/cancel?id="+sessionID, nil),
	)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("cancel = %d %s, want 400", recorder.Code, recorder.Body.String())
	}
	if calls, _ := sender.abortInfo(); calls != 0 {
		t.Fatalf("AbortExisting called %d times before workspace authorization", calls)
	}
}

func TestHostedSessionResolutionRejectsNonCodexProjection(t *testing.T) {
	s, _, root := newHostedSurfaceServer(t, auth.New(""), false)
	projectDir := filepath.Join(s.sessionsDir, "project")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sessionID := "pi-session.jsonl"
	content := `{"type":"session","version":3,"id":"pi-session","timestamp":"2026-05-06T00:00:00.000Z","cwd":` +
		jsonString(root) + `}` + "\n"
	if err := os.WriteFile(filepath.Join(projectDir, sessionID), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := s.resolveSession(sessionID); !errors.Is(err, errHostedNonCodexSession) {
		t.Fatalf("resolve non-Codex projection error = %v", err)
	}
	recorder := httptest.NewRecorder()
	s.handleApiSession(
		recorder,
		httptest.NewRequest(http.MethodGet, "/api/session?id="+sessionID, nil),
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("GET non-Codex Session = %d %s, want 400", recorder.Code, recorder.Body.String())
	}
}

func pathBody(_ string, path string) map[string]any {
	return map[string]any{"path": path, "runtime": "codex"}
}

func mkdirTestPath(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func serveHostedCreate(t *testing.T, s *Server, key string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/new-session", bytes.NewReader(data))
	request.Header.Set("Idempotency-Key", key)
	recorder := httptest.NewRecorder()
	s.handleNewSession(recorder, request)
	return recorder
}

func TestHostedProxyAuthenticatesBeforeCreateMutation(t *testing.T) {
	proxyAuth, err := auth.NewProxyOnly("X-Pican-Proxy-Auth", "secret")
	if err != nil {
		t.Fatal(err)
	}
	s, fake, _ := newHostedSurfaceServer(t, proxyAuth, false)
	mux := http.NewServeMux()
	s.Register(mux)

	request := httptest.NewRequest(http.MethodPost, "/api/new-session", bytes.NewReader([]byte(`{}`)))
	request.Header.Set("Idempotency-Key", "unauthorized-create")
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized create = %d %s", recorder.Code, recorder.Body.String())
	}
	if fake.calls != 0 {
		t.Fatalf("Codex StartSession called %d times before proxy authorization", fake.calls)
	}
	if _, err := s.sessionCreates.Get(context.Background(), "unauthorized-create"); !errors.Is(err, sessioncreate.ErrRecordMissing) {
		t.Fatalf("idempotency state mutated before proxy authorization: %v", err)
	}
}

func TestServiceSurfaceMatrixDocumentsModeDifference(t *testing.T) {
	hosted := serviceSurfaceFor(true)
	standalone := serviceSurfaceFor(false)
	if !hosted.sqlite || !hosted.sessionCreate || !hosted.sessionFiles ||
		!hosted.statusWatcher || !hosted.statusSweeper {
		t.Fatalf("hosted retained-service matrix is incomplete: %+v", hosted)
	}
	if standalone == hosted || !standalone.schedules || !standalone.push ||
		!standalone.workflowsWatcher || !standalone.tasksWatcher ||
		!standalone.scheduler || !standalone.chatQueue || !standalone.queueDrainer ||
		!standalone.updater || !standalone.metrics {
		t.Fatalf("standalone-only service matrix is incomplete: %+v", standalone)
	}
}

func TestHostedSurfaceServerUsesCanonicalWorkspaceRoot(t *testing.T) {
	parent := t.TempDir()
	realRoot := filepath.Join(parent, "real")
	stateRoot := filepath.Join(realRoot, ".pican")
	sessionsRoot := filepath.Join(stateRoot, "sessions")
	if err := os.MkdirAll(sessionsRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	configuredRoot := filepath.Join(parent, "configured")
	if err := os.Symlink(realRoot, configuredRoot); err != nil {
		t.Fatal(err)
	}
	fake := &hostedSurfaceCodex{fakeCodexService: &fakeCodexService{root: sessionsRoot}}
	s, err := New(Deps{
		AgentDir:         stateRoot,
		SessionsDir:      sessionsRoot,
		Hosted:           true,
		WorkspaceRoot:    configuredRoot,
		Auth:             auth.New(""),
		Cache:            sessions.NewCache(),
		EnabledRuntimes:  []string{"codex"},
		RuntimeAvailable: func(string) (bool, string) { return true, "" },
		Codex:            fake,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Shutdown)

	recorder := serveHostedCreate(t, s, "canonical-root", map[string]any{})
	if recorder.Code != http.StatusOK {
		t.Fatalf("create = %d %s", recorder.Code, recorder.Body.String())
	}
	canonical, err := filepath.EvalSymlinks(realRoot)
	if err != nil {
		t.Fatal(err)
	}
	if fake.cwd != canonical {
		t.Fatalf("Codex cwd = %q, want canonical root %q", fake.cwd, canonical)
	}
}
