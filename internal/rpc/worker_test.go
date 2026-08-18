package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"

	"pican/internal/workers"
)

type nopWriteCloser struct{ w io.Writer }

func (n nopWriteCloser) Write(p []byte) (int, error) { return n.w.Write(p) }
func (n nopWriteCloser) Close() error                { return nil }

type commandCapture struct {
	writes chan []byte
}

func (c *commandCapture) Write(p []byte) (int, error) {
	command := append([]byte(nil), p...)
	c.writes <- command
	return len(p), nil
}

func (*commandCapture) Close() error { return nil }

func waitForPending(t *testing.T, w *piRPCWorker, id string) {
	t.Helper()
	for i := 0; i < 1000; i++ {
		w.mu.Lock()
		_, ok := w.pending[id]
		w.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("pending request %q never registered", id)
}

func TestStatusReportsRunningDuringRecentStreamActivity(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)

	if got := w.Status(); got.State != workers.WorkerStateRunning {
		t.Fatalf("status = %q, want running", got.State)
	}
}

func TestAbortWritesNativeRPCAndReturnsWorkerToIdle(t *testing.T) {
	stdin := &commandCapture{writes: make(chan []byte, 1)}
	var notified workers.WorkerStatus
	w := &piRPCWorker{
		stdin:      stdin,
		status:     workers.WorkerStatus{State: workers.WorkerStateRunning},
		pending:    make(map[string]chan response),
		statusSink: func(status workers.WorkerStatus) { notified = status },
	}
	w.lastStreamActivity.Store(time.Now().UnixNano())

	abortDone := make(chan error, 1)
	go func() { abortDone <- w.Abort(context.Background()) }()

	var wire []byte
	select {
	case wire = <-stdin.writes:
	case <-time.After(time.Second):
		t.Fatal("abort command was not written")
	}
	var command struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(wire), &command); err != nil {
		t.Fatal(err)
	}
	if command.ID != "req-1" || command.Type != "abort" {
		t.Fatalf("abort command = %+v", command)
	}

	w.handleRPCLine(`{"type":"response","id":"req-1","command":"abort","success":true}`)
	if err := <-abortDone; err != nil {
		t.Fatal(err)
	}
	if got := w.Status(); got.State != workers.WorkerStateIdle || got.Error != "" {
		t.Fatalf("status after native abort acknowledgement = %#v", got)
	}
	if notified.State != workers.WorkerStateIdle {
		t.Fatalf("published status after native abort acknowledgement = %#v", notified)
	}
}

func TestWaitPropagatesWorkerExitCodeToStatusSink(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 23")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	var notified workers.WorkerStatus
	w := &piRPCWorker{
		cmd:        cmd,
		status:     workers.WorkerStatus{State: workers.WorkerStateRunning},
		pending:    make(map[string]chan response),
		statusSink: func(status workers.WorkerStatus) { notified = status },
	}

	w.wait()

	got := w.Status()
	if got.State != workers.WorkerStateError || got.ExitCode == nil || *got.ExitCode != 23 {
		t.Fatalf("status = %#v, want error with exit code 23", got)
	}
	if notified.ExitCode == nil || *notified.ExitCode != 23 {
		t.Fatalf("notified = %#v, want exit code 23", notified)
	}
}

func TestWorkerExitCodeEnrichesEarlierEOFError(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateRunning},
		pending: make(map[string]chan response),
	}
	w.setError(io.ErrUnexpectedEOF, nil)
	exitCode := 41
	w.setError(errors.New("exit status 41"), &exitCode)

	got := w.Status()
	if got.ExitCode == nil || *got.ExitCode != 41 {
		t.Fatalf("status = %#v, want enriched exit code 41", got)
	}
}

func TestWorkerStderrCaptureIsBounded(t *testing.T) {
	stderr := &workers.BoundedWriter{Max: 64 << 10}
	w := &piRPCWorker{stderrBuf: stderr}
	input := strings.Repeat("a", 70<<10) + "stderr-tail"
	if _, err := stderr.Write([]byte(input)); err != nil {
		t.Fatal(err)
	}

	if got := len(stderr.String()); got != 64<<10 {
		t.Fatalf("captured stderr bytes = %d, want %d", got, 64<<10)
	}
	if err := w.withStderr(errors.New("worker failed")); !strings.HasSuffix(err.Error(), "stderr-tail") {
		t.Fatalf("worker error lost stderr tail: %v", err)
	}
}

func TestIntentionalCloseDoesNotPublishWorkerDown(t *testing.T) {
	var notifications int
	w := &piRPCWorker{
		status:     workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending:    make(map[string]chan response),
		statusSink: func(workers.WorkerStatus) { notifications++ },
	}

	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	w.setError(io.ErrUnexpectedEOF, nil)

	if notifications != 0 {
		t.Fatalf("status notifications = %d, want 0 for intentional close", notifications)
	}
}

func TestStatusReturnsIdleAfterAgentEnd(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateRunning},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)
	w.handleRPCLine(`{"type":"agent_end"}`)

	if got := w.Status(); got.State != workers.WorkerStateIdle {
		t.Fatalf("status = %q, want idle", got.State)
	}
}

func TestStatusDoesNotStayRunningAfterStreamActivityExpires(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)
	time.Sleep(2200 * time.Millisecond)

	if got := w.Status(); got.State != workers.WorkerStateIdle {
		t.Fatalf("status = %q, want idle after stream activity expires", got.State)
	}
}

func TestHandleRPCLineTracksTurnEndAsStreamActivity(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"turn_end"}`)

	if got := w.Status(); got.State != workers.WorkerStateRunning {
		t.Fatalf("status = %q, want running", got.State)
	}
}

func TestHandleRPCLineEmitsStreamPreviewCallbacks(t *testing.T) {
	var previews []StreamPreview
	fakeNow := time.Unix(1000, 0)
	w := &piRPCWorker{
		status:        workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending:       make(map[string]chan response),
		streamSink:    func(preview StreamPreview) { previews = append(previews, preview) },
		streamPreview: &streamPreviewAccumulator{},
		previewClock:  func() time.Time { return fakeNow },
	}

	// Space the two deltas apart by more than streamPreviewMinInterval so
	// the emission throttle (added alongside coalesced chat-preview SSE
	// pushes) doesn't collapse them — this test is about plumbing and
	// cumulative content, not throttling, which has its own tests.
	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hel"}}`)
	fakeNow = fakeNow.Add(streamPreviewMinInterval)
	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"lo"}}`)

	if len(previews) != 2 {
		t.Fatalf("previews = %d, want 2", len(previews))
	}
	if previews[0].Content != "hel" || previews[0].Done {
		t.Fatalf("first preview = %+v", previews[0])
	}
	if previews[1].Content != "hello" || previews[1].Done {
		t.Fatalf("second preview = %+v", previews[1])
	}
}

func TestHandleRPCLineEmitsDonePreviewOnAgentEnd(t *testing.T) {
	var previews []StreamPreview
	w := &piRPCWorker{
		status:        workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending:       make(map[string]chan response),
		streamSink:    func(preview StreamPreview) { previews = append(previews, preview) },
		streamPreview: &streamPreviewAccumulator{},
	}

	w.handleRPCLine(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hello"}}`)
	w.handleRPCLine(`{"type":"agent_end"}`)

	if len(previews) != 2 {
		t.Fatalf("previews = %d, want 2", len(previews))
	}
	if previews[1].Content != "hello" || !previews[1].Done {
		t.Fatalf("done preview = %+v", previews[1])
	}
}

func TestHandleRPCLineTracksMessageEndAsStreamActivity(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{"type":"message_end"}`)

	if got := w.Status(); got.State != workers.WorkerStateRunning {
		t.Fatalf("status = %q, want running", got.State)
	}
}

func TestGetCommandsReturnsCachedWithoutRPC(t *testing.T) {
	w := &piRPCWorker{
		pending:        make(map[string]chan response),
		commands:       []workers.SlashCommand{{Name: "skill:memory", Source: "skill"}},
		commandsCached: true,
	}
	// stdin is nil: the cache path must not attempt any RPC write.
	got, err := w.GetCommands(context.Background())
	if err != nil {
		t.Fatalf("GetCommands error: %v", err)
	}
	if len(got) != 1 || got[0].Name != "skill:memory" {
		t.Fatalf("got = %#v", got)
	}
}

func TestGetCommandsParsesResponseAndCaches(t *testing.T) {
	var buf bytes.Buffer
	w := &piRPCWorker{
		stdin:   nopWriteCloser{&buf},
		pending: make(map[string]chan response),
	}

	type result struct {
		cmds []workers.SlashCommand
		err  error
	}
	resCh := make(chan result, 1)
	go func() {
		cmds, err := w.GetCommands(context.Background())
		resCh <- result{cmds, err}
	}()

	waitForPending(t, w, "req-1")
	w.handleRPCLine(`{"type":"response","id":"req-1","command":"get_commands","success":true,"data":{"commands":[{"name":"skill:memory","description":"mem","source":"skill"},{"name":"ext:note","description":"take a note","source":"extension"}]}}`)

	got := <-resCh
	if got.err != nil {
		t.Fatalf("GetCommands error: %v", got.err)
	}
	if len(got.cmds) != 2 {
		t.Fatalf("commands = %#v", got.cmds)
	}
	if got.cmds[0].Name != "skill:memory" || got.cmds[0].Source != "skill" || got.cmds[0].Description != "mem" {
		t.Fatalf("first command = %#v", got.cmds[0])
	}

	// Second call must hit the cache: no further RPC write to stdin.
	buf.Reset()
	cached, err := w.GetCommands(context.Background())
	if err != nil {
		t.Fatalf("cached GetCommands error: %v", err)
	}
	if len(cached) != 2 {
		t.Fatalf("cached commands = %#v", cached)
	}
	if buf.Len() != 0 {
		t.Fatalf("cache hit wrote to stdin: %q", buf.String())
	}
}

func TestHandleRPCLineIgnoresMalformedJSON(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	w.handleRPCLine(`{not-json}`)

	if got := w.Status(); got.State != workers.WorkerStateIdle {
		t.Fatalf("status = %q, want idle", got.State)
	}
}

func TestHandleRPCLineTracksThinkingAndTextStreamEvents(t *testing.T) {
	w := &piRPCWorker{
		status:  workers.WorkerStatus{State: workers.WorkerStateIdle},
		pending: make(map[string]chan response),
	}

	for _, line := range []string{
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_end"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"done"}}`,
	} {
		w.handleRPCLine(line)
		if got := w.Status(); got.State != workers.WorkerStateRunning {
			t.Fatalf("line %s => status = %q, want running", strings.TrimSpace(line), got.State)
		}
	}
}

func TestExtensionUIRequestLifecycle(t *testing.T) {
	var stdin bytes.Buffer
	var eventName string
	var eventPayload json.RawMessage
	w := &piRPCWorker{
		stdin:              nopWriteCloser{&stdin},
		pending:            make(map[string]chan response),
		pendingExtensionUI: make(map[string]pendingExtensionUIRequest),
		extensionUISink: func(event string, payload json.RawMessage) {
			eventName = event
			eventPayload = append(json.RawMessage(nil), payload...)
		},
	}

	request := `{"type":"extension_ui_request","id":"ui-1","method":"confirm","title":"Deploy?","message":"Ship it"}`
	w.handleRPCLine(request)
	if eventName != "extension-ui-request" || string(eventPayload) != request {
		t.Fatalf("event = %q %s", eventName, eventPayload)
	}
	if got := w.PendingExtensionUI(); len(got) != 1 || !bytes.Contains(got[0], []byte(`"id":"ui-1"`)) {
		t.Fatalf("pending = %s", got)
	}

	confirmed := false
	if err := w.RespondExtensionUI("ui-1", workers.ExtensionUIResponse{Confirmed: &confirmed}); err != nil {
		t.Fatal(err)
	}
	if got := stdin.String(); got != `{"confirmed":false,"id":"ui-1","type":"extension_ui_response"}`+"\n" {
		t.Fatalf("stdin = %q", got)
	}
	if got := w.PendingExtensionUI(); len(got) != 0 {
		t.Fatalf("pending after response = %s", got)
	}
	if err := w.RespondExtensionUI("ui-1", workers.ExtensionUIResponse{}); !errors.Is(err, workers.ErrExtensionUIRequestNotFound) {
		t.Fatalf("unknown response error = %v", err)
	}
}

func TestExtensionUIPendingClearsOnWorkerError(t *testing.T) {
	w := &piRPCWorker{
		pending:            make(map[string]chan response),
		pendingExtensionUI: make(map[string]pendingExtensionUIRequest),
	}
	w.handleRPCLine(`{"type":"extension_ui_request","id":"ui-1","method":"input","title":"Name"}`)
	w.setError(io.ErrUnexpectedEOF, nil)
	if got := w.PendingExtensionUI(); len(got) != 0 {
		t.Fatalf("pending after exit = %s", got)
	}
}

func TestExtensionUINotifyEmitsWithoutStoring(t *testing.T) {
	var eventName string
	var eventPayload json.RawMessage
	w := &piRPCWorker{
		pending:            make(map[string]chan response),
		pendingExtensionUI: make(map[string]pendingExtensionUIRequest),
		extensionUISink: func(event string, payload json.RawMessage) {
			eventName, eventPayload = event, payload
		},
	}
	w.handleRPCLine(`{"type":"extension_ui_request","id":"ui-1","method":"notify","message":"Done","notifyType":"info"}`)
	if eventName != "extension-notify" || string(eventPayload) != `{"message":"Done","type":"info"}` {
		t.Fatalf("notification = %q %s", eventName, eventPayload)
	}
	if got := w.PendingExtensionUI(); len(got) != 0 {
		t.Fatalf("notify stored as pending: %s", got)
	}
}

// TestEmitStreamPreviewThrottlesBurstButAlwaysEmitsDone is a regression test
// for the upstream token-flood: a burst of text_delta events emitted faster
// than streamPreviewMinInterval apart should be coalesced by the throttle
// (only the deltas that land on/after an allowed tick get pushed), while the
// terminal text_end preview must always be emitted regardless of timing.
func TestEmitStreamPreviewThrottlesBurstButAlwaysEmitsDone(t *testing.T) {
	// Started away from the Unix epoch; see comment in
	// TestEmitStreamPreviewAllowsSteadyRateAboveMinInterval.
	fakeNow := time.Unix(1000, 0)
	var previews []StreamPreview
	w := &piRPCWorker{
		pending:       make(map[string]chan response),
		streamPreview: &streamPreviewAccumulator{},
		streamSink:    func(p StreamPreview) { previews = append(previews, p) },
		previewClock:  func() time.Time { return fakeNow },
	}

	// 10 deltas, each 10ms apart (100ms total) — well under the ~50ms min
	// interval means only ~2-3 should get through, not all 10.
	for i := 0; i < 10; i++ {
		w.emitStreamPreview(assistantMessageEvent{Type: "text_delta", Delta: "x"})
		fakeNow = fakeNow.Add(10 * time.Millisecond)
	}
	if len(previews) >= 10 {
		t.Fatalf("expected throttling to drop some deltas, got %d/10 emitted", len(previews))
	}
	if len(previews) == 0 {
		t.Fatal("expected at least one preview to be emitted")
	}

	// The final text_end must always be emitted even though it lands
	// immediately after a throttled delta (no time advance).
	w.emitStreamPreview(assistantMessageEvent{Type: "text_end", Content: "xxxxxxxxxx"})
	last := previews[len(previews)-1]
	if !last.Done || last.Content != "xxxxxxxxxx" {
		t.Fatalf("expected final done preview with full content, got %+v", last)
	}
}

func TestEmitStreamPreviewAllowsSteadyRateAboveMinInterval(t *testing.T) {
	// Start away from the Unix epoch: lastPreviewEmit's zero-value sentinel
	// (meaning "never emitted") would otherwise collide with a fake clock
	// that starts at exactly time.Unix(0, 0), an artifact of this test's
	// fake clock rather than anything reachable with a real wall clock.
	fakeNow := time.Unix(1000, 0)
	var previews []StreamPreview
	w := &piRPCWorker{
		pending:       make(map[string]chan response),
		streamPreview: &streamPreviewAccumulator{},
		streamSink:    func(p StreamPreview) { previews = append(previews, p) },
		previewClock:  func() time.Time { return fakeNow },
	}

	for i := 0; i < 5; i++ {
		w.emitStreamPreview(assistantMessageEvent{Type: "text_delta", Delta: "x"})
		fakeNow = fakeNow.Add(streamPreviewMinInterval)
	}
	if len(previews) != 5 {
		t.Fatalf("expected all 5 deltas at >= min interval to be emitted, got %d", len(previews))
	}
}
