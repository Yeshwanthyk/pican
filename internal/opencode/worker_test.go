package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"pican/internal/chat"
	"pican/internal/workers"
)

func TestWorkerPromptDemultiplexPreviewRefreshAndCancel(t *testing.T) {
	cwd := t.TempDir()
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	projection, err := Materialize(sessionsDir, Session{
		ID: "ses_worker", Directory: cwd, Title: "Worker",
		Time: SessionTime{Created: time.Now().UnixMilli(), Updated: time.Now().UnixMilli()},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := SetProjectionModel(projection.Path, "anthropic/claude-sonnet", nil); err != nil {
		t.Fatal(err)
	}
	canonicalCWD, err := CanonicalDirectory(cwd)
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var prompt PromptRequest
	abortCalls := 0
	abortAccepted := true
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/session/status":
			_, _ = writer.Write([]byte(`{}`))
		case "/session/ses_worker/prompt_async":
			if request.URL.Query().Get("directory") != canonicalCWD {
				t.Errorf("prompt directory = %q", request.URL.Query().Get("directory"))
			}
			if err := json.NewDecoder(request.Body).Decode(&prompt); err != nil {
				t.Errorf("decode prompt: %v", err)
			}
			writer.WriteHeader(http.StatusNoContent)
		case "/session/ses_worker/abort":
			mu.Lock()
			abortCalls++
			accepted := abortAccepted
			mu.Unlock()
			if request.Method != http.MethodPost {
				t.Errorf("abort method = %q", request.Method)
			}
			if request.URL.Query().Get("directory") != canonicalCWD {
				t.Errorf("abort directory = %q", request.URL.Query().Get("directory"))
			}
			_ = json.NewEncoder(writer).Encode(accepted)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "pican", "secret", nil, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	supervisor := readyTestSupervisor(client)
	previewCh := make(chan Preview, 8)
	statusCh := make(chan workers.WorkerStatus, 8)
	refreshCh := make(chan struct{}, 8)
	worker, err := NewWorkerWithOptions(projection.Path, WorkerCallbacks{
		Preview: func(preview Preview) { previewCh <- preview },
		Status:  func(status workers.WorkerStatus) { statusCh <- status },
	}, WorkerOptions{
		Supervisor: supervisor,
		Refresh: func(context.Context, string, string) (Projection, error) {
			refreshCh <- struct{}{}
			return projection, nil
		},
		PreviewMaxBytes: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()

	if err := worker.Prompt(context.Background(), chat.Request{Message: "hello"}); err != nil {
		t.Fatal(err)
	}
	if prompt.Model == nil || prompt.Model.ProviderID != "anthropic" || prompt.Model.ModelID != "claude-sonnet" {
		t.Fatalf("prompt model = %#v", prompt.Model)
	}
	if worker.Status().State != workers.WorkerStateRunning {
		t.Fatalf("status = %#v", worker.Status())
	}

	// A foreign session never reaches this worker.
	supervisor.dispatch(testEvent(cwd, "ses_foreign", "message.part.delta", map[string]any{
		"sessionID": "ses_foreign", "messageID": "msg-x", "partID": "part-x", "delta": "foreign",
	}))
	supervisor.dispatch(testEvent(cwd, "ses_worker", "message.part.delta", map[string]any{
		"sessionID": "ses_worker", "messageID": "msg-1", "partID": "part-1", "delta": "héllo!",
	}))
	select {
	case preview := <-previewCh:
		if preview.Content != "llo!" || !utf8.ValidString(preview.Content) {
			t.Fatalf("bounded preview = %q", preview.Content)
		}
	case <-time.After(time.Second):
		t.Fatal("missing preview")
	}

	if err := worker.Abort(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	gotAbortCalls := abortCalls
	mu.Unlock()
	if gotAbortCalls != 1 || worker.Status().State != workers.WorkerStateIdle {
		t.Fatalf("abort calls = %d, status = %#v", gotAbortCalls, worker.Status())
	}
	select {
	case <-refreshCh:
	case <-time.After(time.Second):
		t.Fatal("abort did not request authoritative refresh")
	}

	if err := worker.Prompt(context.Background(), chat.Request{Message: "second turn"}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	abortAccepted = false
	mu.Unlock()
	if err := worker.Abort(context.Background()); err == nil {
		t.Fatal("rejected native abort returned nil")
	}
	if got := worker.Status(); got.State != workers.WorkerStateRunning || !strings.Contains(got.Error, "refused to abort") {
		t.Fatalf("status after rejected native abort = %#v", got)
	}
}

func TestWorkerIgnoresDirectoryMismatchAndFailsClosedForUnsupportedOperations(t *testing.T) {
	cwd := t.TempDir()
	foreign := t.TempDir()
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	_ = os.MkdirAll(sessionsDir, 0o755)
	projection, err := Materialize(sessionsDir, Session{
		ID: "ses_scope", Directory: cwd, Title: "Scope",
		Time: SessionTime{Created: time.Now().UnixMilli(), Updated: time.Now().UnixMilli()},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/session/status" {
			_, _ = writer.Write([]byte(`{}`))
			return
		}
		if request.URL.Path == "/session/ses_scope/prompt_async" {
			writer.WriteHeader(http.StatusNoContent)
			return
		}
		http.NotFound(writer, request)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, "pican", "secret", nil, time.Second)
	supervisor := readyTestSupervisor(client)
	worker, err := NewWorker(projection.Path, supervisor, nil, WorkerCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	if err := worker.Prompt(context.Background(), chat.Request{Images: []chat.Image{{MimeType: "image/png", Data: "x"}}}); err == nil {
		t.Fatal("attachment was accepted")
	}
	if err := worker.SetThinkingLevel(context.Background(), "high"); err == nil {
		t.Fatal("reasoning selection was accepted")
	}
	if _, err := worker.GetCommands(context.Background()); err == nil {
		t.Fatal("slash commands were accepted")
	}
	if err := worker.Prompt(context.Background(), chat.Request{Message: "hello"}); err != nil {
		t.Fatal(err)
	}
	supervisor.dispatch(testEvent(foreign, "ses_scope", "session.idle", map[string]any{"sessionID": "ses_scope"}))
	time.Sleep(50 * time.Millisecond)
	if worker.Status().State != workers.WorkerStateRunning {
		t.Fatalf("cross-cwd event changed worker status = %#v", worker.Status())
	}
}

func TestWorkerReadsNativeBusyStateBeforeSending(t *testing.T) {
	cwd := t.TempDir()
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	projection, err := Materialize(sessionsDir, Session{
		ID: "ses_busy", Directory: cwd, Title: "Busy",
		Time: SessionTime{Created: time.Now().UnixMilli(), Updated: time.Now().UnixMilli()},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	promptCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/session/status":
			_, _ = writer.Write([]byte(`{"ses_busy":{"type":"busy"}}`))
		case "/session/ses_busy/prompt_async":
			promptCalls++
			writer.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client, err := NewClient(server.URL, "pican", "secret", nil, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := NewWorker(projection.Path, readyTestSupervisor(client), nil, WorkerCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()

	status, err := worker.GetState(context.Background())
	if err != nil || status.State != workers.WorkerStateRunning {
		t.Fatalf("status = %#v, err=%v", status, err)
	}
	if err := worker.Prompt(context.Background(), chat.Request{Message: "second"}); !errors.Is(err, ErrTurnInProgress) {
		t.Fatalf("prompt error = %v", err)
	}
	if promptCalls != 0 {
		t.Fatalf("prompt calls = %d", promptCalls)
	}
}

func readyTestSupervisor(client *Client) *Supervisor {
	supervisor := NewSupervisor(Options{Command: "unused"})
	supervisor.mu.Lock()
	supervisor.client = client
	supervisor.availability = Availability{Available: true, Version: "1.18.4", ChangedAt: time.Now()}
	supervisor.startedAt = time.Now()
	supervisor.mu.Unlock()
	return supervisor
}

func testEvent(directory, sessionID, eventType string, properties any) Event {
	data, _ := json.Marshal(properties)
	return Event{
		Directory: directory,
		Payload:   EventPayload{Type: eventType, Properties: data},
	}
}
