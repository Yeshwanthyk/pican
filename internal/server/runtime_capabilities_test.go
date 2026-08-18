package server

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pican/internal/projections"
	"pican/internal/runtimes"
	"pican/internal/sessions"
	"pican/internal/workers"
)

func futureRegistry(t *testing.T, capabilities runtimes.Capabilities, available bool, reason string) *runtimes.Registry {
	t.Helper()
	registration := runtimes.Registration{
		Descriptor: runtimes.Descriptor{
			ID:             "future",
			Label:          "Future",
			Command:        "future",
			ProjectionMode: runtimes.ProjectionAppendOnlyNative,
			Capabilities:   capabilities,
		},
		AvailabilityProbe: func(context.Context) runtimes.Availability {
			return runtimes.Availability{Available: available, Reason: reason}
		},
	}
	if capabilities.Chat {
		registration.WorkerFactory = compatibilityWorkerFactory
	}
	registry, err := runtimes.New(registration)
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func writeFutureSession(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, "project")
	cwd := filepath.Join(root, "cwd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "future-native-1.jsonl")
	content := `{"type":"session","id":"native-1","cwd":` + jsonString(cwd) + `,"runtime":"future","nativeId":"native-1"}` + "\n" +
		`{"type":"message","id":"entry-1","message":{"role":"user","content":"hello"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRegisteredRuntimeWithoutCapabilitiesFailsClosed(t *testing.T) {
	root := t.TempDir()
	path := writeFutureSession(t, root)
	s := &Server{
		sessionsDir:     root,
		cache:           sessions.NewCache(),
		runtimeRegistry: futureRegistry(t, runtimes.Capabilities{}, true, ""),
		defaultRuntime:  "future",
	}

	tests := []struct {
		name    string
		handler http.HandlerFunc
		request *http.Request
		want    string
	}{
		{
			name:    "create",
			handler: s.handleNewSession,
			request: httptest.NewRequest(http.MethodPost, "/api/new-session", strings.NewReader(`{"path":"`+t.TempDir()+`","runtime":"future"}`)),
			want:    "Future runtime does not support create",
		},
		{
			name:    "fork",
			handler: s.handleApiForkSession,
			request: httptest.NewRequest(http.MethodPost, "/api/fork-session?id="+filepath.Base(path), strings.NewReader(`{"entryId":"entry-1"}`)),
			want:    "Future runtime does not support fork",
		},
		{
			name:    "clone",
			handler: s.handleApiCloneSession,
			request: httptest.NewRequest(http.MethodPost, "/api/clone-session?id="+filepath.Base(path), strings.NewReader(`{}`)),
			want:    "Future runtime does not support clone",
		},
		{
			name:    "rename",
			handler: s.handleRenameSession,
			request: httptest.NewRequest(http.MethodPost, "/api/rename-session?id="+filepath.Base(path), strings.NewReader(`{"name":"unsafe"}`)),
			want:    "Future runtime does not support rename",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			tt.handler(recorder, tt.request)
			if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), tt.want) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "unsafe") {
		t.Fatal("unsupported rename mutated the projection")
	}
}

func TestSessionOperationCapabilitiesFailClosedBeforeAdapters(t *testing.T) {
	root := t.TempDir()
	path := writeFutureSession(t, root)
	s := &Server{
		sessionsDir:     root,
		runtimeRegistry: futureRegistry(t, runtimes.Capabilities{}, true, ""),
	}
	id := filepath.Base(path)
	tests := []struct {
		name    string
		handler http.HandlerFunc
		request *http.Request
		want    string
	}{
		{"chat", s.handleChat, httptest.NewRequest(http.MethodPost, "/api/chat?id="+id, nil), "does not support chat"},
		{"cancel", s.handleCancelChat, httptest.NewRequest(http.MethodPost, "/api/chat/cancel?id="+id, nil), "does not support cancel"},
		{"queue", s.handleChatQueue, httptest.NewRequest(http.MethodGet, "/api/chat/queue?id="+id, nil), "does not support persistent queue"},
		{"models", s.handleAvailableModels, httptest.NewRequest(http.MethodGet, "/api/models?id="+id+"&runtime=pi", nil), "does not support model listing"},
		{"model switching", s.handleSetModel, httptest.NewRequest(http.MethodPost, "/api/set-model?id="+id, nil), "does not support model switching"},
		{"thinking", s.handleSetThinkingLevel, httptest.NewRequest(http.MethodPost, "/api/set-thinking-level?id="+id, nil), "does not support effort or reasoning selection"},
		{"slash commands", s.handleCommands, httptest.NewRequest(http.MethodGet, "/api/commands?id="+id, nil), "does not support slash commands"},
		{"files", s.handleApiFiles, httptest.NewRequest(http.MethodGet, "/api/files?id="+id, nil), "does not support file references"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			tt.handler(recorder, tt.request)
			if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), tt.want) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestChatEnforcesImageAndSteerCapabilities(t *testing.T) {
	root := t.TempDir()
	path := writeFutureSession(t, root)
	id := filepath.Base(path)

	t.Run("images", func(t *testing.T) {
		s := &Server{
			sessionsDir:     root,
			chatSender:      &fakeSender{},
			runtimeRegistry: futureRegistry(t, runtimes.Capabilities{Chat: true}, true, ""),
		}
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("images", "tiny.png")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write([]byte("\x89PNG\r\n\x1a\n"))
		_ = writer.Close()
		req := httptest.NewRequest(http.MethodPost, "/api/chat?id="+id, &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		recorder := httptest.NewRecorder()
		s.handleChat(recorder, req)
		if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "does not support image attachments") {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("steer", func(t *testing.T) {
		s := &Server{
			sessionsDir: root,
			chatSender: &fakeSender{status: workers.WorkerStatus{
				State: workers.WorkerStateRunning,
			}},
			runtimeRegistry: futureRegistry(t, runtimes.Capabilities{Chat: true}, true, ""),
		}
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		_ = writer.WriteField("message", "interrupt")
		_ = writer.Close()
		req := httptest.NewRequest(http.MethodPost, "/api/chat?id="+id, &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		recorder := httptest.NewRecorder()
		s.handleChat(recorder, req)
		if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), "does not support steer") {
			t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
		}
	})
}

func TestSupportedOperationOnUnavailableRuntimeReturns503(t *testing.T) {
	root := t.TempDir()
	path := writeFutureSession(t, root)
	s := &Server{
		sessionsDir:     root,
		chatSender:      &fakeSender{},
		runtimeRegistry: futureRegistry(t, runtimes.Capabilities{Chat: true}, false, "future daemon offline"),
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("message", "hello")
	_ = writer.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/chat?id="+filepath.Base(path), &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	recorder := httptest.NewRecorder()

	s.handleChat(recorder, req)

	if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "future daemon offline") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestSessionResponseIncludesTrustedRuntimeMetadata(t *testing.T) {
	root := t.TempDir()
	path := writeFutureSession(t, root)
	s := &Server{
		sessionsDir:     root,
		cache:           sessions.NewCache(),
		runtimeRegistry: futureRegistry(t, runtimes.Capabilities{Files: true}, true, ""),
	}
	recorder := httptest.NewRecorder()
	s.handleApiSession(recorder, httptest.NewRequest(http.MethodGet, "/api/session?id="+filepath.Base(path), nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Runtime        string                `json:"runtime"`
		RuntimeLabel   string                `json:"runtimeLabel"`
		ProjectionMode string                `json:"projectionMode"`
		ResumeCommand  string                `json:"resumeCommand"`
		Capabilities   runtimes.Capabilities `json:"capabilities"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Runtime != "future" || response.RuntimeLabel != "Future" || response.ProjectionMode != "append-only-native" || response.ResumeCommand != "" || !response.Capabilities.Files || response.Capabilities.Chat {
		t.Fatalf("metadata = %+v", response)
	}
}

func TestReplaceableRuntimeLabelsUseIdentityValidatedProjectionStore(t *testing.T) {
	root := t.TempDir()
	cwd := t.TempDir()
	canonicalCWD := projections.CanonicalCWD(cwd)
	store, err := projections.NewStore(root, "future")
	if err != nil {
		t.Fatal(err)
	}
	projection, err := store.Replace("native-1", cwd, func([]string) ([]map[string]any, error) {
		return []map[string]any{
			{"type": "session", "id": "native-1", "cwd": canonicalCWD, "runtime": "future", "nativeId": "native-1"},
			{"type": "message", "id": "entry-1", "message": map[string]any{"role": "user", "content": "hello"}},
		}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	registry, err := runtimes.New(runtimes.Registration{
		Descriptor: runtimes.Descriptor{
			ID: "future", Label: "Future", Command: "future",
			ProjectionMode: runtimes.ProjectionReplaceable,
		},
		AvailabilityProbe: func(context.Context) runtimes.Availability {
			return runtimes.Availability{Available: true}
		},
		Catalog: compatibilityCatalog{},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{sessionsDir: root, cache: sessions.NewCache(), runtimeRegistry: registry}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/label-session-entry?id="+projection.ID, strings.NewReader(`{"entryId":"entry-1","label":"checkpoint"}`))

	s.handleLabelSessionEntry(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	data, err := os.ReadFile(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"type":"label"`) || !strings.Contains(string(data), `"label":"checkpoint"`) {
		t.Fatalf("projection = %s", data)
	}
}

func TestTerminalResumeCommandShellQuotesTrustedDescriptorAndSessionID(t *testing.T) {
	available := func(context.Context) runtimes.Availability { return runtimes.Availability{Available: true} }
	registry, err := runtimes.New(
		runtimes.Pi(runtimes.BuiltinOptions{
			Command: "/Applications/Pi Tool/pi", WorkerFactory: compatibilityWorkerFactory, AvailabilityProbe: available,
		}),
		runtimes.Claude(runtimes.BuiltinOptions{
			Command: "/Applications/Claude Tool/claude", AvailabilityProbe: available,
			Catalog: compatibilityCatalog{}, WorkerFactory: compatibilityWorkerFactory,
		}),
		runtimes.OpenCode(runtimes.BuiltinOptions{
			Command: "/Applications/OpenCode Tool/opencode", AvailabilityProbe: available,
			Catalog: compatibilityCatalog{}, WorkerFactory: compatibilityWorkerFactory,
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{runtimeRegistry: registry, claudeHome: "/Users/example/Claude Home"}
	command := s.terminalResumeCommand(sessions.Session{SessionSummary: sessions.SessionSummary{
		Runtime: "pi", SessionUUID: "abc'; touch /tmp/pwn",
	}})
	want := `'/Applications/Pi Tool/pi' --session 'abc'\''; touch /tmp/pwn'`
	if command != want {
		t.Fatalf("command = %q, want %q", command, want)
	}
	claudeCommand := s.terminalResumeCommand(sessions.Session{SessionSummary: sessions.SessionSummary{
		Runtime: "claude", NativeID: "00000000-0000-4000-8000-000000000001",
	}})
	claudeWant := `CLAUDE_CONFIG_DIR='/Users/example/Claude Home' '/Applications/Claude Tool/claude' --resume 00000000-0000-4000-8000-000000000001`
	if claudeCommand != claudeWant {
		t.Fatalf("Claude command = %q, want %q", claudeCommand, claudeWant)
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	s.claudeHome = filepath.Join(userHome, ".claude")
	defaultCommand := s.terminalResumeCommand(sessions.Session{SessionSummary: sessions.SessionSummary{
		Runtime: "claude", NativeID: "00000000-0000-4000-8000-000000000001",
	}})
	defaultWant := `'/Applications/Claude Tool/claude' --resume 00000000-0000-4000-8000-000000000001`
	if defaultCommand != defaultWant {
		t.Fatalf("default-profile Claude command = %q, want %q", defaultCommand, defaultWant)
	}
	openCodeCommand := s.terminalResumeCommand(sessions.Session{SessionSummary: sessions.SessionSummary{
		Runtime: "opencode", NativeID: "ses_abc'; touch /tmp/pwn",
	}})
	openCodeWant := `'/Applications/OpenCode Tool/opencode' --session 'ses_abc'\''; touch /tmp/pwn'`
	if openCodeCommand != openCodeWant {
		t.Fatalf("OpenCode command = %q, want %q", openCodeCommand, openCodeWant)
	}
}
