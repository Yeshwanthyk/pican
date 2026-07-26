package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"pican/internal/chat"
	"pican/internal/workers"
)

func TestWorkerClearsPreviewOnAbortWithoutActiveTurn(t *testing.T) {
	w := &Worker{
		preview: map[string]*strings.Builder{"turn\x00item": {}},
	}

	if err := w.Abort(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(w.preview) != 0 {
		t.Fatalf("preview entries after abort = %d, want 0", len(w.preview))
	}
}

func TestWorkerClearsPreviewOnProtocolError(t *testing.T) {
	w := &Worker{
		preview:  map[string]*strings.Builder{"turn\x00item": {}},
		statusCh: make(chan workers.WorkerStatus, 1),
	}

	wantErr := errors.New("protocol failed")
	if got := w.protocolError(wantErr); !errors.Is(got, wantErr) {
		t.Fatalf("protocolError() = %v, want %v", got, wantErr)
	}
	if len(w.preview) != 0 {
		t.Fatalf("preview entries after protocol error = %d, want 0", len(w.preview))
	}
}

func TestWorkerAbortInterruptsAnnouncedTurnWhileStartAckIsPending(t *testing.T) {
	root := t.TempDir()
	thread := testThread()
	thread.CWD = "/tmp/project"
	projection, err := Materialize(root, thread)
	if err != nil {
		t.Fatal(err)
	}
	logPath := root + "/rpc.jsonl"
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	w, err := NewWorker(ctx, projection.Path, helperCommand("start-ack-pending", logPath), Callbacks{})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	promptErr := make(chan error, 1)
	go func() {
		promptErr <- w.Prompt(context.Background(), chat.Request{Message: "work"})
	}()
	deadline := time.Now().Add(time.Second)
	for {
		w.mu.Lock()
		active := w.activeTurn
		w.mu.Unlock()
		if active == "turn-live" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("turn/started did not publish the active turn identity")
		}
		time.Sleep(time.Millisecond)
	}

	abortErr := make(chan error, 1)
	go func() {
		abortErr <- w.Abort(context.Background())
	}()
	select {
	case err := <-abortErr:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Abort blocked behind the pending turn/start acknowledgement")
	}
	select {
	case err := <-promptErr:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Prompt did not reconcile after the interrupted turn completed")
	}

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	var interrupt struct {
		Method string `json:"method"`
		Params struct {
			ThreadID string `json:"threadId"`
			TurnID   string `json:"turnId"`
		} `json:"params"`
	}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var request struct {
			Method string `json:"method"`
			Params struct {
				ThreadID string `json:"threadId"`
				TurnID   string `json:"turnId"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(line), &request) == nil && request.Method == "turn/interrupt" {
			interrupt = request
			break
		}
	}
	if interrupt.Method != "turn/interrupt" || interrupt.Params.ThreadID != "thread-1" || interrupt.Params.TurnID != "turn-live" {
		t.Fatalf("interrupt request = %+v; wire log:\n%s", interrupt, data)
	}
}

func TestWorkerAbortTimesOutWhenInterruptHasNoReply(t *testing.T) {
	root := t.TempDir()
	thread := testThread()
	thread.CWD = "/tmp/project"
	projection, err := Materialize(root, thread)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	w, err := NewWorker(ctx, projection.Path, helperCommand("interrupt-no-reply", root+"/rpc.jsonl"), Callbacks{})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	w.interruptTimeout = 50 * time.Millisecond
	if err := w.Prompt(ctx, chat.Request{Message: "work"}); err != nil {
		t.Fatal(err)
	}

	abortErr := make(chan error, 1)
	started := time.Now()
	go func() {
		abortErr <- w.Abort(context.Background())
	}()
	select {
	case err := <-abortErr:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Abort error = %v, want deadline exceeded", err)
		}
		if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
			t.Fatalf("Abort took %s, want bounded interrupt timeout", elapsed)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("Abort hung waiting for a turn/interrupt response")
	}
	if status := w.Status(); status.State != workers.WorkerStateRunning {
		t.Fatalf("unknown interrupt outcome changed authoritative running state: %+v", status)
	}
}

func TestWorkerResumePromptSteerInterruptSettingsStatusAndPreview(t *testing.T) {
	root := t.TempDir()
	thread := testThread()
	thread.CWD = "/tmp/project"
	projection, err := Materialize(root, thread)
	if err != nil {
		t.Fatal(err)
	}
	logPath := root + "/rpc.log"
	var mu sync.Mutex
	var previews []Preview
	var statuses []workers.WorkerStatus
	var projections []Projection
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	w, err := NewWorker(ctx, projection.Path, helperCommand("worker", logPath), Callbacks{Preview: func(p Preview) { mu.Lock(); previews = append(previews, p); mu.Unlock() }, Status: func(s workers.WorkerStatus) { mu.Lock(); statuses = append(statuses, s); mu.Unlock() }, Projection: func(p Projection) { mu.Lock(); projections = append(projections, p); mu.Unlock() }})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if w.Status().State != workers.WorkerStateIdle || w.Status().ModelProvider != Provider {
		t.Fatalf("unexpected initial status: %+v", w.Status())
	}
	if err := w.SetModel(ctx, Provider, "gpt-next"); err != nil {
		t.Fatal(err)
	}
	if err := w.SetThinkingLevel(ctx, "high"); err != nil {
		t.Fatal(err)
	}
	if err := w.Prompt(ctx, chat.Request{Message: "first", Images: []chat.Image{{Data: "YWJj", MimeType: "image/png"}}}); err != nil {
		t.Fatal(err)
	}
	if w.Status().State != workers.WorkerStateRunning {
		t.Fatalf("expected running: %+v", w.Status())
	}
	if err := w.Prompt(ctx, chat.Request{Message: "steer"}); err != nil {
		t.Fatal(err)
	}
	if err := w.Abort(ctx); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && w.Status().State != workers.WorkerStateIdle {
		time.Sleep(10 * time.Millisecond)
	}
	if w.Status().State != workers.WorkerStateIdle {
		t.Fatalf("turn did not complete: %+v", w.Status())
	}
	mu.Lock()
	previewCopy := append([]Preview(nil), previews...)
	statusCopy := append([]workers.WorkerStatus(nil), statuses...)
	projectionCopy := append([]Projection(nil), projections...)
	mu.Unlock()
	if len(previewCopy) < 2 || previewCopy[0].Text != "hello" || !previewCopy[len(previewCopy)-1].Done {
		t.Fatalf("preview callbacks: %+v", previewCopy)
	}
	if len(statusCopy) == 0 {
		t.Fatal("no status callbacks")
	}
	if len(projectionCopy) == 0 {
		t.Fatal("no projection callbacks")
	}
	commands, _ := w.GetCommands(ctx)
	if len(commands) != 2 || commands[0].Name != "review" || commands[1].Name != "compact" {
		t.Fatalf("commands: %+v", commands)
	}
	if err := w.Prompt(ctx, chat.Request{Message: "/review"}); err != nil {
		t.Fatal(err)
	}
	if err := w.Abort(ctx); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) && w.Status().State != workers.WorkerStateIdle {
		time.Sleep(10 * time.Millisecond)
	}
	if err := w.Prompt(ctx, chat.Request{Message: "/compact"}); err != nil {
		t.Fatal(err)
	}
	logData, _ := os.ReadFile(logPath)
	log := string(logData)
	for _, method := range []string{"initialize", "thread/resume", "thread/read", "turn/start", "turn/steer", "turn/interrupt", "review/start", "thread/compact/start"} {
		if !strings.Contains(log, method) {
			t.Errorf("missing %s in log:\n%s", method, log)
		}
	}
	projectionData, _ := os.ReadFile(projection.Path)
	text := string(projectionData)
	if !strings.Contains(text, `"type":"model_change"`) || !strings.Contains(text, `"modelId":"gpt-next"`) || !strings.Contains(text, `"thinkingLevel":"high"`) {
		t.Fatalf("sticky settings missing: %s", text)
	}
}

func TestWorkerSeparatesAgentPreviewFromProjectionAndToolOutput(t *testing.T) {
	root := t.TempDir()
	thread := testThread()
	thread.CWD = "/tmp/project"
	projection, err := Materialize(root, thread)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var previews []Preview
	var callbackOrder []string
	projectionCount := 0
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	w, err := NewWorker(ctx, projection.Path, helperCommand("normal"), Callbacks{
		Preview: func(p Preview) {
			mu.Lock()
			previews = append(previews, p)
			if p.Done {
				callbackOrder = append(callbackOrder, "done")
			}
			mu.Unlock()
		},
		Projection: func(Projection) {
			mu.Lock()
			projectionCount++
			callbackOrder = append(callbackOrder, "projection")
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	mu.Lock()
	projectionCount = 0 // Ignore NewWorker's initial authoritative materialization.
	callbackOrder = nil
	mu.Unlock()

	w.handleNotification(Notification{Method: "item/started", Params: []byte(`{"threadId":"thread-1","turnId":"turn-live","item":{"id":"agent-live","type":"agentMessage","text":""}}`)})
	w.handleNotification(Notification{Method: "item/agentMessage/delta", Params: []byte(`{"threadId":"thread-1","turnId":"turn-live","itemId":"agent-live","delta":"partial"}`)})
	time.Sleep(150 * time.Millisecond)

	mu.Lock()
	gotPreviews := append([]Preview(nil), previews...)
	gotProjectionCount := projectionCount
	mu.Unlock()
	if len(gotPreviews) != 1 || gotPreviews[0].Text != "partial" || gotPreviews[0].Done {
		t.Fatalf("agent preview callbacks = %+v", gotPreviews)
	}
	if gotProjectionCount != 0 {
		t.Fatalf("agent delta materialized %d projections; preview must be the sole partial-text owner", gotProjectionCount)
	}
	data, err := os.ReadFile(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "partial") {
		t.Fatal("partial agent text leaked into the canonical projection")
	}

	w.handleNotification(Notification{Method: "item/completed", Params: []byte(`{"threadId":"thread-1","turnId":"turn-live","item":{"id":"agent-live","type":"agentMessage","text":"complete"}}`)})
	data, err = os.ReadFile(projection.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "complete") {
		t.Fatal("completed agent item was not materialized")
	}
	mu.Lock()
	if len(previews) != 2 || !previews[1].Done || previews[1].Text != "complete" {
		t.Fatalf("completed agent preview callbacks = %+v", previews)
	}
	if strings.Join(callbackOrder, ",") != "projection,done" {
		t.Fatalf("completion callback order = %v, want canonical projection before done", callbackOrder)
	}
	previewCount := len(previews)
	mu.Unlock()

	w.handleNotification(Notification{Method: "item/started", Params: []byte(`{"threadId":"thread-1","turnId":"turn-live","item":{"id":"cmd-live","type":"commandExecution","command":"pwd","status":"inProgress"}}`)})
	w.handleNotification(Notification{Method: "item/commandExecution/outputDelta", Params: []byte(`{"threadId":"thread-1","turnId":"turn-live","itemId":"cmd-live","delta":"/tmp/project\\n"}`)})
	w.handleNotification(Notification{Method: "item/completed", Params: []byte(`{"threadId":"thread-1","turnId":"turn-live","item":{"id":"cmd-live","type":"commandExecution","command":"pwd","status":"completed","aggregatedOutput":"/tmp/project\\n"}}`)})
	mu.Lock()
	defer mu.Unlock()
	if len(previews) != previewCount {
		t.Fatalf("tool output leaked into assistant previews: %+v", previews[previewCount:])
	}
}

func TestWorkerMaterializesEachRevisionOnce(t *testing.T) {
	root := t.TempDir()
	thread := testThread()
	thread.CWD = t.TempDir()
	projectionCount := 0
	w := &Worker{
		sessionsDir: root,
		revision:    1,
		callbacks: Callbacks{Projection: func(Projection) {
			projectionCount++
		}},
	}

	w.materializeRevision(thread, 1)
	w.materializeRevision(thread, 1)

	if projectionCount != 2 {
		t.Fatalf("projection callbacks = %d, want cached projection reuse on the second call", projectionCount)
	}
	if !w.hasMaterializedRevision || w.materializedRevision != 1 || w.materializedProjection.Path == "" {
		t.Fatalf("materialized revision cache = has:%v revision:%d projection:%+v", w.hasMaterializedRevision, w.materializedRevision, w.materializedProjection)
	}
}

func TestPreserveLocalTurnsRejectsLaggingTemporaryItemIdentities(t *testing.T) {
	local := Thread{Turns: []Turn{{ID: "turn-live", Status: "completed", Items: []ThreadItem{
		item("user", "userMessage", map[string]any{"content": []any{}}),
		item("commentary", "agentMessage", map[string]any{"text": "checking"}),
		item("command", "commandExecution", map[string]any{"status": "completed", "aggregatedOutput": "ok"}),
		item("final", "agentMessage", map[string]any{"text": "local final"}),
	}}}}
	staleRead := Thread{Turns: []Turn{{ID: "turn-live", Status: "completed", Items: []ThreadItem{
		item("item-1", "userMessage", map[string]any{"content": []any{}}),
		item("item-2", "agentMessage", map[string]any{"text": "checking"}),
		item("item-3", "agentMessage", map[string]any{"text": "stale final"}),
	}}}}

	merged := preserveLocalTurns(staleRead, local, "turn-live")
	if len(merged.Turns) != 1 || len(merged.Turns[0].Items) != 4 {
		t.Fatalf("merged turns = %+v", merged.Turns)
	}
	var ids []string
	for _, item := range merged.Turns[0].Items {
		ids = append(ids, item.ID)
	}
	if strings.Join(ids, ",") != "user,commentary,command,final" {
		t.Fatalf("merged item order = %v", ids)
	}
	if got := rawString(merged.Turns[0].Items[3].Raw["text"]); got != "local final" {
		t.Fatalf("live completed turn was not preserved: %q", got)
	}
}

func TestWorkerRoutesOnlyItsThreadNotifications(t *testing.T) {
	w := &Worker{
		nativeID:       "thread-own",
		status:         workers.WorkerStatus{State: workers.WorkerStateIdle},
		preview:        map[string]*strings.Builder{},
		completedTurns: map[string]struct{}{},
		statusCh:       make(chan workers.WorkerStatus, 4),
	}
	w.handleNotification(Notification{Method: "turn/started", Params: []byte(`{"threadId":"thread-foreign","turn":{"id":"turn-foreign","status":"inProgress","items":[]}}`)})
	if w.activeTurn != "" || w.Status().State != workers.WorkerStateIdle {
		t.Fatalf("foreign turn changed worker: active=%q status=%+v", w.activeTurn, w.Status())
	}
	w.handleNotification(Notification{Method: "turn/started", Params: []byte(`{"threadId":"thread-own","turn":{"id":"turn-own","status":"inProgress","items":[]}}`)})
	if w.activeTurn != "turn-own" || w.Status().State != workers.WorkerStateRunning {
		t.Fatalf("own turn not routed: active=%q status=%+v", w.activeTurn, w.Status())
	}
	w.handleNotification(Notification{Method: "turn/completed", Params: []byte(`{"threadId":"thread-foreign","turn":{"id":"turn-own","status":"completed","items":[]}}`)})
	if w.activeTurn != "turn-own" {
		t.Fatalf("foreign completion cleared exact active turn: %q", w.activeTurn)
	}
}

func TestWorkerLiveNotificationsStatusRetryAndLateCompletion(t *testing.T) {
	root := t.TempDir()
	thread := testThread()
	thread.CWD = "/tmp/project"
	projection, err := Materialize(root, thread)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	w, err := NewWorker(ctx, projection.Path, helperCommand("normal"), Callbacks{})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	w.handleNotification(Notification{Method: "turn/started", Params: []byte(`{"threadId":"thread-1","turn":{"id":"turn-old","status":"inProgress","items":[]}}`)})
	w.handleNotification(Notification{Method: "item/started", Params: []byte(`{"threadId":"thread-1","turnId":"turn-old","startedAtMs":1,"item":{"id":"cmd","type":"commandExecution","command":"echo hi","cwd":"/tmp/project","status":"inProgress","aggregatedOutput":""}}`)})
	w.handleNotification(Notification{Method: "item/commandExecution/outputDelta", Params: []byte(`{"threadId":"thread-1","turnId":"turn-old","itemId":"cmd","delta":"hi\\n"}`)})
	w.handleNotification(Notification{Method: "turn/plan/updated", Params: []byte(`{"threadId":"thread-1","turnId":"turn-old","plan":[{"step":"test","status":"inProgress"}]}`)})
	w.handleNotification(Notification{Method: "thread/tokenUsage/updated", Params: []byte(`{"threadId":"thread-1","turnId":"turn-old","tokenUsage":{"total":{"inputTokens":1,"cachedInputTokens":0,"outputTokens":2,"reasoningOutputTokens":0,"totalTokens":3},"last":{"inputTokens":1,"cachedInputTokens":0,"outputTokens":2,"reasoningOutputTokens":0,"totalTokens":3}}}`)})
	w.handleNotification(Notification{Method: "error", Params: []byte(`{"threadId":"thread-1","turnId":"turn-old","willRetry":true,"error":{"message":"temporary"}}`)})
	if w.Status().State == workers.WorkerStateError {
		t.Fatalf("retry became fatal: %+v", w.Status())
	}
	time.Sleep(200 * time.Millisecond)
	data, _ := os.ReadFile(projection.Path)
	text := string(data)
	for _, want := range []string{"aggregatedOutput", "codexTokenUsage", "temporary"} {
		if !strings.Contains(text, want) {
			t.Errorf("projection missing %q: %s", want, text)
		}
	}
	w.handleNotification(Notification{Method: "turn/started", Params: []byte(`{"threadId":"thread-1","turn":{"id":"turn-new","status":"inProgress","items":[]}}`)})
	w.handleNotification(Notification{Method: "turn/completed", Params: []byte(`{"threadId":"thread-1","turn":{"id":"turn-old","status":"completed","items":[]}}`)})
	if w.activeTurn != "turn-new" {
		t.Fatalf("late completion cleared newer turn: %q", w.activeTurn)
	}
	w.handleNotification(Notification{Method: "thread/status/changed", Params: []byte(`{"threadId":"thread-1","status":{"type":"idle"}}`)})
	if w.activeTurn != "" || w.Status().State != workers.WorkerStateIdle {
		t.Fatalf("idle did not clear stale turn: active=%q status=%+v", w.activeTurn, w.Status())
	}
}

func TestActiveTurnIDUsesOnlyInProgressTurn(t *testing.T) {
	thread := Thread{Turns: []Turn{{ID: "done", Status: "completed"}, {ID: "active", Status: "inProgress"}}}
	if got := activeTurnID(thread); got != "active" {
		t.Fatalf("active turn = %q", got)
	}
}

func TestWorkerRejectsNonCodexProjection(t *testing.T) {
	path := t.TempDir() + "/pi.jsonl"
	if err := os.WriteFile(path, []byte(`{"type":"session","id":"pi","cwd":"/tmp"}`+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewWorker(context.Background(), path, nil, Callbacks{}); err == nil {
		t.Fatal("expected rejection")
	}
}
