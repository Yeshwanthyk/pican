package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"pican/internal/chat"
	"pican/internal/sessions"
	"pican/internal/workers"
)

type fakeClaudeProcess struct {
	stdin   *fakeClaudeStdin
	stdoutR *io.PipeReader
	stdoutW *io.PipeWriter
	stderrR *io.PipeReader
	stderrW *io.PipeWriter

	mu       sync.Mutex
	started  bool
	killed   bool
	exited   bool
	exitCode int
	waitErr  error
	waitCh   chan struct{}
	exitOnce sync.Once
}

type fakeClaudeStdin struct {
	lines             chan []byte
	closed            chan struct{}
	once              sync.Once
	mu                sync.Mutex
	firstWriteStarted chan struct{}
	firstWriteRelease chan struct{}
	writeCount        int
}

func newFakeClaudeProcess() *fakeClaudeProcess {
	stdoutR, stdoutW := io.Pipe()
	stderrR, stderrW := io.Pipe()
	return &fakeClaudeProcess{
		stdin:   &fakeClaudeStdin{lines: make(chan []byte, 16), closed: make(chan struct{})},
		stdoutR: stdoutR, stdoutW: stdoutW, stderrR: stderrR, stderrW: stderrW,
		waitCh: make(chan struct{}), exitCode: -1,
	}
}

func (s *fakeClaudeStdin) Write(data []byte) (int, error) {
	s.mu.Lock()
	first := s.writeCount == 0
	s.writeCount++
	started := s.firstWriteStarted
	release := s.firstWriteRelease
	s.mu.Unlock()
	if first && started != nil {
		close(started)
		<-release
	}
	copyData := append([]byte(nil), data...)
	select {
	case s.lines <- copyData:
		return len(data), nil
	case <-s.closed:
		return 0, io.ErrClosedPipe
	}
}
func (s *fakeClaudeStdin) Close() error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func (p *fakeClaudeProcess) Start() error {
	p.mu.Lock()
	p.started = true
	p.mu.Unlock()
	return nil
}
func (p *fakeClaudeProcess) Wait() error {
	<-p.waitCh
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.waitErr
}
func (p *fakeClaudeProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *fakeClaudeProcess) Stdout() io.Reader     { return p.stdoutR }
func (p *fakeClaudeProcess) Stderr() io.Reader     { return p.stderrR }
func (p *fakeClaudeProcess) PID() int              { return 4242 }
func (p *fakeClaudeProcess) ExitCode() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exitCode
}
func (p *fakeClaudeProcess) Kill() error {
	p.mu.Lock()
	alreadyExited := p.exited
	p.killed = true
	p.mu.Unlock()
	if alreadyExited {
		return os.ErrProcessDone
	}
	p.exit(-1, errors.New("killed"))
	return nil
}
func (p *fakeClaudeProcess) emit(line string) {
	_, _ = io.WriteString(p.stdoutW, line+"\n")
}
func (p *fakeClaudeProcess) emitStderr(text string) { _, _ = io.WriteString(p.stderrW, text) }
func (p *fakeClaudeProcess) exit(code int, err error) {
	p.exitOnce.Do(func() {
		p.mu.Lock()
		p.exited = true
		p.exitCode = code
		p.waitErr = err
		p.mu.Unlock()
		_ = p.stdoutW.Close()
		_ = p.stderrW.Close()
		close(p.waitCh)
	})
}

func readFakeLine(t *testing.T, process *fakeClaudeProcess) []byte {
	t.Helper()
	select {
	case line := <-process.stdin.lines:
		if len(line) == 0 || line[len(line)-1] != '\n' || bytes.Count(line, []byte{'\n'}) != 1 {
			t.Fatalf("stdin write is not one NDJSON frame: %q", line)
		}
		return line
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Claude stdin")
		return nil
	}
}

func waitWorkerState(t *testing.T, worker *Worker, state workers.State) workers.WorkerStatus {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status := worker.Status()
		if status.State == state {
			return status
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("worker state = %+v, want %s", worker.Status(), state)
	return workers.WorkerStatus{}
}

func projectionsCanonicalForTest(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved
	}
	return path
}

func pendingProjection(t *testing.T, nativeID, cwd string) Projection {
	t.Helper()
	projection, err := createSessionProjection(t.TempDir(), nativeID, cwd, "haiku", time.Unix(1, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	return projection
}

func testInit(nativeID, cwd string) string {
	data, _ := json.Marshal(map[string]any{
		"type": "system", "subtype": "init", "session_id": nativeID,
		"cwd": cwd, "model": "claude-haiku", "permissionMode": "bypassPermissions",
	})
	return string(data)
}

func TestBuildWorkerArgsExactFreshAndResumeMutualExclusion(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000100"
	prefix := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--dangerously-skip-permissions",
		"--model", "haiku",
	}
	fresh := append(append([]string(nil), prefix...), "--session-id", nativeID)
	resume := append(append([]string(nil), prefix...), "--resume", nativeID)
	if got := BuildWorkerArgs(nativeID, "haiku", true); !reflect.DeepEqual(got, fresh) {
		t.Fatalf("fresh argv = %#v, want %#v", got, fresh)
	}
	if got := BuildWorkerArgs(nativeID, "haiku", false); !reflect.DeepEqual(got, resume) {
		t.Fatalf("resume argv = %#v, want %#v", got, resume)
	}
}

func TestWorkerRejectsUnsupportedOrMalformedImageBeforeWriting(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000109"
	projection := pendingProjection(t, nativeID, t.TempDir())
	process := newFakeClaudeProcess()
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory: func(ProcessSpec) (Process, error) { return process, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	for _, request := range []chat.Request{
		{Images: []chat.Image{{MimeType: "image/bmp", Data: "YWJj"}}},
		{Images: []chat.Image{{MimeType: "image/png", Data: "not-base64"}}},
	} {
		if err := worker.Prompt(context.Background(), request); err == nil {
			t.Fatalf("Prompt(%+v) succeeded", request)
		}
	}
	select {
	case line := <-process.stdin.lines:
		t.Fatalf("invalid image wrote stdin: %q", line)
	default:
	}
	if status := worker.Status(); status.State != workers.WorkerStateIdle {
		t.Fatalf("invalid input changed status: %+v", status)
	}
}

type chunkWriter struct {
	bytes.Buffer
	chunk int
}

func (w *chunkWriter) Write(data []byte) (int, error) {
	if len(data) > w.chunk {
		data = data[:w.chunk]
	}
	return w.Buffer.Write(data)
}

func TestWriteFullCompletesShortWrites(t *testing.T) {
	writer := &chunkWriter{chunk: 2}
	if err := writeFull(writer, []byte("frame\n")); err != nil {
		t.Fatal(err)
	}
	if got := writer.String(); got != "frame\n" {
		t.Fatalf("written frame = %q", got)
	}
}

func TestWorkerFreshArgvInputFramingStreamingAndReuse(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000101"
	cwd := t.TempDir()
	projection := pendingProjection(t, nativeID, cwd)
	process := newFakeClaudeProcess()
	var spec ProcessSpec
	var mu sync.Mutex
	var previews []Preview
	var order []string
	worker, err := NewWorkerWithOptions(projection.Path, "/path with spaces/claude", t.TempDir(), Callbacks{
		Preview: func(preview Preview) {
			mu.Lock()
			previews = append(previews, preview)
			if preview.Done {
				order = append(order, "done")
			}
			mu.Unlock()
		},
		Projection: func(Projection) {
			mu.Lock()
			order = append(order, "projection")
			mu.Unlock()
		},
	}, WorkerOptions{
		ProcessFactory: func(got ProcessSpec) (Process, error) { spec = got; return process, nil },
		Refresh: func(context.Context, string, string) (Projection, bool, error) {
			return projection, true, nil
		},
		RefreshDelay: time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	if !process.started || spec.Command != "/path with spaces/claude" || spec.Dir != filepath.Clean(projectionsCanonicalForTest(cwd)) {
		t.Fatalf("process spec = %+v started=%v", spec, process.started)
	}
	for _, arg := range []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose", "--dangerously-skip-permissions", "--model", "haiku", "--session-id", nativeID} {
		if !slices.Contains(spec.Args, arg) {
			t.Fatalf("fresh argv missing %q: %#v", arg, spec.Args)
		}
	}
	if slices.Contains(spec.Args, "--resume") {
		t.Fatalf("fresh argv contains --resume: %#v", spec.Args)
	}

	promptDone := make(chan error, 1)
	go func() {
		promptDone <- worker.Prompt(context.Background(), chat.Request{
			Message: "hello", Images: []chat.Image{{Data: "YWJj", MimeType: "image/png"}},
		})
	}()
	line := readFakeLine(t, process)
	var input struct {
		Type    string `json:"type"`
		Message struct {
			Role    string                   `json:"role"`
			Content []map[string]interface{} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &input); err != nil {
		t.Fatal(err)
	}
	if input.Type != "user" || input.Message.Role != "user" || len(input.Message.Content) != 2 {
		t.Fatalf("input = %+v", input)
	}
	source, _ := input.Message.Content[1]["source"].(map[string]interface{})
	if input.Message.Content[0]["text"] != "hello" || source["media_type"] != "image/png" || source["data"] != "YWJj" {
		t.Fatalf("input content = %+v", input.Message.Content)
	}
	select {
	case err := <-promptDone:
		t.Fatalf("Prompt returned before init: %v", err)
	default:
	}
	process.emit(testInit(nativeID, cwd))
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	process.emit(`{"type":"stream_event","session_id":"` + nativeID + `","event":{"type":"message_start","message":{"id":"msg-1"}}}`)
	process.emit(`{"type":"stream_event","session_id":"` + nativeID + `","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}}`)
	process.emit(`{"type":"assistant","session_id":"` + nativeID + `","message":{"id":"msg-1","model":"claude-haiku","role":"assistant","content":[{"type":"text","text":"hello"}]}}`)
	process.emit(`{"type":"result","subtype":"success","is_error":false,"session_id":"` + nativeID + `","result":"hello"}`)
	waitWorkerState(t, worker, workers.WorkerStateIdle)
	mu.Lock()
	if len(previews) < 3 || previews[0].Content != "hel" || previews[len(previews)-1].Content != "hello" || !previews[len(previews)-1].Done || previews[len(previews)-1].ItemID != "msg-1" {
		t.Fatalf("previews = %+v", previews)
	}
	if strings.Join(order, ",") != "done,projection" {
		t.Fatalf("completion order = %v", order)
	}
	mu.Unlock()

	if err := worker.Prompt(context.Background(), chat.Request{Message: "second"}); err != nil {
		t.Fatal(err)
	}
	second := readFakeLine(t, process)
	if !bytes.Contains(second, []byte(`"text":"second"`)) {
		t.Fatalf("second prompt = %s", second)
	}
}

func TestWorkerBoundsPreviewWithoutSplittingUTF8(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000110"
	cwd := t.TempDir()
	projection := pendingProjection(t, nativeID, cwd)
	process := newFakeClaudeProcess()
	previews := make(chan Preview, 4)
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{
		Preview: func(preview Preview) { previews <- preview },
	}, WorkerOptions{
		ProcessFactory:  func(ProcessSpec) (Process, error) { return process, nil },
		PreviewMaxBytes: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "hello"}) }()
	_ = readFakeLine(t, process)
	process.emit(testInit(nativeID, cwd))
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	process.emit(`{"type":"stream_event","session_id":"` + nativeID + `","event":{"type":"message_start","message":{"id":"msg-bounded"}}}`)
	process.emit(`{"type":"stream_event","session_id":"` + nativeID + `","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"abc😀"}}}`)
	process.emit(`{"type":"stream_event","session_id":"` + nativeID + `","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"de"}}}`)
	var latest Preview
	for range 2 {
		select {
		case latest = <-previews:
		case <-time.After(time.Second):
			t.Fatal("preview not published")
		}
	}
	if latest.Content != "abcde" || len(latest.Content) > 5 || !utf8.ValidString(latest.Content) {
		t.Fatalf("bounded preview = %q", latest.Content)
	}
}

func TestWorkerResumeArgvAndInitIdentityInvariant(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000102"
	cwd := t.TempDir()
	projection := pendingProjection(t, nativeID, cwd)
	process := newFakeClaudeProcess()
	var spec ProcessSpec
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory: func(got ProcessSpec) (Process, error) { spec = got; return process, nil },
		NativeExists:   func(string) bool { return true },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	if !slices.Contains(spec.Args, "--resume") || slices.Contains(spec.Args, "--session-id") {
		t.Fatalf("resume argv violated mutual exclusion: %#v", spec.Args)
	}
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "hello"}) }()
	_ = readFakeLine(t, process)
	process.emit(testInit("00000000-0000-4000-8000-000000000999", cwd))
	if err := <-promptDone; err == nil || !strings.Contains(err.Error(), "session id mismatch") {
		t.Fatalf("Prompt error = %v", err)
	}
	status := waitWorkerState(t, worker, workers.WorkerStateError)
	if !strings.Contains(status.Error, "session id mismatch") {
		t.Fatalf("status = %+v", status)
	}
	process.mu.Lock()
	killed := process.killed
	process.mu.Unlock()
	if !killed {
		t.Fatal("identity mismatch did not terminate process tree")
	}
}

func TestWorkerInitRejectsCWDAndPermissionModeMismatch(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000114"
	tests := []struct {
		name      string
		mutate    func(map[string]any)
		wantError string
	}{
		{
			name:      "cwd",
			mutate:    func(init map[string]any) { init["cwd"] = t.TempDir() },
			wantError: "cwd mismatch",
		},
		{
			name:      "permission",
			mutate:    func(init map[string]any) { init["permissionMode"] = "manual" },
			wantError: "is not bypassPermissions",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cwd := t.TempDir()
			projection := pendingProjection(t, nativeID, cwd)
			process := newFakeClaudeProcess()
			worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
				ProcessFactory: func(ProcessSpec) (Process, error) { return process, nil },
			})
			if err != nil {
				t.Fatal(err)
			}
			defer worker.Close()
			promptDone := make(chan error, 1)
			go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "hello"}) }()
			_ = readFakeLine(t, process)
			init := map[string]any{
				"type": "system", "subtype": "init", "session_id": nativeID,
				"cwd": cwd, "model": "haiku", "permissionMode": "bypassPermissions",
			}
			test.mutate(init)
			data, _ := json.Marshal(init)
			process.emit(string(data))
			if err := <-promptDone; err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("Prompt error = %v, want %q", err, test.wantError)
			}
			waitWorkerState(t, worker, workers.WorkerStateError)
		})
	}
}

func TestWorkerUnknownErrorMalformedAndExitRecords(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000103"
	cwd := t.TempDir()
	projection := pendingProjection(t, nativeID, cwd)
	process := newFakeClaudeProcess()
	unknown := make(chan string, 1)
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{
		Unknown: func(recordType string) { unknown <- recordType },
	}, WorkerOptions{
		ProcessFactory: func(ProcessSpec) (Process, error) { return process, nil },
		Refresh:        func(context.Context, string, string) (Projection, bool, error) { return projection, true, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "hello"}) }()
	_ = readFakeLine(t, process)
	process.emit(testInit(nativeID, cwd))
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	process.emit(`{"type":"future_record","session_id":"` + nativeID + `","value":1}`)
	if got := <-unknown; got != "future_record" {
		t.Fatalf("unknown record = %q", got)
	}
	process.emit(`{"type":"error","session_id":"` + nativeID + `","message":"rate limited"}`)
	process.emit(`{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"` + nativeID + `","errors":["request failed"]}`)
	status := waitWorkerState(t, worker, workers.WorkerStateIdle)
	if status.Error != "request failed" {
		t.Fatalf("result error status = %+v", status)
	}
	if err := worker.Close(); err != nil {
		t.Fatal(err)
	}

	malformedProcess := newFakeClaudeProcess()
	malformedWorker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory: func(ProcessSpec) (Process, error) { return malformedProcess, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	malformedProcess.emit(`{not-json}`)
	malformedStatus := waitWorkerState(t, malformedWorker, workers.WorkerStateError)
	if !strings.Contains(malformedStatus.Error, "invalid Claude stream-json line") {
		t.Fatalf("malformed status = %+v", malformedStatus)
	}
	_ = malformedWorker.Close()

	exitProcess := newFakeClaudeProcess()
	exitWorker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory: func(ProcessSpec) (Process, error) { return exitProcess, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	exitProcess.emitStderr("native crash")
	exitProcess.exit(23, errors.New("exit status 23"))
	exitStatus := waitWorkerState(t, exitWorker, workers.WorkerStateError)
	deadline := time.Now().Add(time.Second)
	for exitStatus.ExitCode == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
		exitStatus = exitWorker.Status()
	}
	if exitStatus.ExitCode == nil || *exitStatus.ExitCode != 23 || !strings.Contains(exitStatus.Error, "native crash") {
		t.Fatalf("exit status = %+v", exitStatus)
	}
	if err := exitWorker.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerRejectsSuccessfulResultWithoutAssistantIdentity(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000111"
	cwd := t.TempDir()
	projection := pendingProjection(t, nativeID, cwd)
	process := newFakeClaudeProcess()
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory: func(ProcessSpec) (Process, error) { return process, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "hello"}) }()
	_ = readFakeLine(t, process)
	process.emit(testInit(nativeID, cwd))
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	process.emit(`{"type":"result","subtype":"success","is_error":false,"session_id":"` + nativeID + `","result":"orphan"}`)
	status := waitWorkerState(t, worker, workers.WorkerStateError)
	if !strings.Contains(status.Error, "without an assistant message id") {
		t.Fatalf("status = %+v", status)
	}
}

func TestWorkerWritesPromptFrameBeforeConcurrentInterrupt(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000115"
	cwd := t.TempDir()
	projection := pendingProjection(t, nativeID, cwd)
	process := newFakeClaudeProcess()
	process.stdin.firstWriteStarted = make(chan struct{})
	process.stdin.firstWriteRelease = make(chan struct{})
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory:   func(ProcessSpec) (Process, error) { return process, nil },
		InterruptTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "long"}) }()
	<-process.stdin.firstWriteStarted
	abortDone := make(chan error, 1)
	go func() { abortDone <- worker.Abort(context.Background()) }()
	select {
	case line := <-process.stdin.lines:
		t.Fatalf("frame completed before release: %q", line)
	default:
	}
	close(process.stdin.firstWriteRelease)
	promptFrame := readFakeLine(t, process)
	interruptFrame := readFakeLine(t, process)
	var promptEnvelope, interruptEnvelope struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal(promptFrame, &promptEnvelope); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(interruptFrame, &interruptEnvelope); err != nil {
		t.Fatal(err)
	}
	if promptEnvelope.Type != "user" || interruptEnvelope.Type != "control_request" {
		t.Fatalf("stdin order = %q then %q", promptEnvelope.Type, interruptEnvelope.Type)
	}
	process.emit(testInit(nativeID, cwd))
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	process.emit(`{"type":"control_response","response":{"subtype":"success","request_id":"` + interruptEnvelope.RequestID + `","still_queued":[]}}`)
	if err := <-abortDone; err != nil {
		t.Fatal(err)
	}
}

func TestWorkerInterruptKeepsProcessReusable(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000104"
	cwd := t.TempDir()
	projection := pendingProjection(t, nativeID, cwd)
	process := newFakeClaudeProcess()
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory:   func(ProcessSpec) (Process, error) { return process, nil },
		Refresh:          func(context.Context, string, string) (Projection, bool, error) { return projection, true, nil },
		InterruptTimeout: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "long"}) }()
	_ = readFakeLine(t, process)
	process.emit(testInit(nativeID, cwd))
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	abortDone := make(chan error, 1)
	go func() { abortDone <- worker.Abort(context.Background()) }()
	controlLine := readFakeLine(t, process)
	var control struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
		Request   struct {
			Subtype string `json:"subtype"`
		} `json:"request"`
	}
	if err := json.Unmarshal(controlLine, &control); err != nil {
		t.Fatal(err)
	}
	if control.Type != "control_request" || control.Request.Subtype != "interrupt" || control.RequestID == "" {
		t.Fatalf("control request = %+v", control)
	}
	process.emit(`{"type":"control_response","response":{"subtype":"success","request_id":"` + control.RequestID + `","still_queued":[]}}`)
	if err := <-abortDone; err != nil {
		t.Fatal(err)
	}
	process.emit(`{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","session_id":"` + nativeID + `"}`)
	waitWorkerState(t, worker, workers.WorkerStateIdle)
	if err := worker.Prompt(context.Background(), chat.Request{Message: "after interrupt"}); err != nil {
		t.Fatal(err)
	}
	if line := readFakeLine(t, process); !bytes.Contains(line, []byte("after interrupt")) {
		t.Fatalf("next prompt = %s", line)
	}
	timedOut := make(chan error, 1)
	go func() { timedOut <- worker.Abort(context.Background()) }()
	_ = readFakeLine(t, process)
	if err := <-timedOut; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timed-out interrupt error = %v", err)
	}
	waitWorkerState(t, worker, workers.WorkerStateError)
	process.mu.Lock()
	killed := process.killed
	process.mu.Unlock()
	if !killed {
		t.Fatal("timed-out interrupt did not terminate process tree")
	}
}

func TestWorkerAbortUnblocksWithProcessExitError(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000112"
	cwd := t.TempDir()
	projection := pendingProjection(t, nativeID, cwd)
	process := newFakeClaudeProcess()
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory:   func(ProcessSpec) (Process, error) { return process, nil },
		InterruptTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "long"}) }()
	_ = readFakeLine(t, process)
	process.emit(testInit(nativeID, cwd))
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	abortDone := make(chan error, 1)
	go func() { abortDone <- worker.Abort(context.Background()) }()
	_ = readFakeLine(t, process)
	process.emitStderr("crashed during interrupt")
	process.exit(19, errors.New("exit status 19"))
	select {
	case err := <-abortDone:
		if err == nil || !strings.Contains(err.Error(), "Claude process exited") {
			t.Fatalf("Abort error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Abort did not unblock on process exit")
	}
	status := waitWorkerState(t, worker, workers.WorkerStateError)
	if !strings.Contains(status.Error, "crashed during interrupt") {
		t.Fatalf("status = %+v", status)
	}
}

func TestWorkerInitializationTimeoutTerminatesProcess(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000116"
	projection := pendingProjection(t, nativeID, t.TempDir())
	process := newFakeClaudeProcess()
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory:        func(ProcessSpec) (Process, error) { return process, nil },
		InitializationTimeout: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "hello"}) }()
	_ = readFakeLine(t, process)
	select {
	case err := <-promptDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Prompt error = %v, want deadline exceeded", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Prompt did not honor the initialization timeout")
	}
	status := waitWorkerState(t, worker, workers.WorkerStateError)
	if !strings.Contains(status.Error, "initialization timed out") {
		t.Fatalf("status = %+v", status)
	}
	process.mu.Lock()
	killed := process.killed
	process.mu.Unlock()
	if !killed {
		t.Fatal("initialization timeout did not terminate process tree")
	}
}

func TestWorkerCloseUnblocksFirstPromptWaitingForInit(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000113"
	projection := pendingProjection(t, nativeID, t.TempDir())
	process := newFakeClaudeProcess()
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{}, WorkerOptions{
		ProcessFactory: func(ProcessSpec) (Process, error) { return process, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "hello"}) }()
	_ = readFakeLine(t, process)
	closeDone := make(chan error, 1)
	go func() { closeDone <- worker.Close() }()
	select {
	case err := <-promptDone:
		if err == nil {
			t.Fatal("Prompt succeeded without initialization")
		}
	case <-time.After(time.Second):
		t.Fatal("Prompt remained blocked during Close")
	}
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Close remained blocked")
	}
}

func TestWorkerCloseKillsAndDrainsWithoutCrashEvent(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000106"
	projection := pendingProjection(t, nativeID, t.TempDir())
	process := newFakeClaudeProcess()
	errorCount := 0
	worker, err := NewWorkerWithOptions(projection.Path, "claude", t.TempDir(), Callbacks{
		Error: func(error) { errorCount++ },
	}, WorkerOptions{ProcessFactory: func(ProcessSpec) (Process, error) { return process, nil }})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Close(); err != nil {
		t.Fatal(err)
	}
	process.mu.Lock()
	killed := process.killed
	process.mu.Unlock()
	if !killed || errorCount != 0 {
		t.Fatalf("close cleanup: killed=%v error callbacks=%d", killed, errorCount)
	}
	select {
	case <-process.stdin.closed:
	default:
		t.Fatal("close did not close Claude stdin")
	}
}

func TestWorkerRefreshesAuthoritativeProjectionOnceBeforePreviewRetires(t *testing.T) {
	const nativeID = "00000000-0000-4000-8000-000000000105"
	cwd := t.TempDir()
	home := t.TempDir()
	sessionsDir := t.TempDir()
	projection, err := createSessionProjection(sessionsDir, nativeID, cwd, "haiku", time.Unix(1, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := NewCatalog(home, sessionsDir)
	if err != nil {
		t.Fatal(err)
	}
	process := newFakeClaudeProcess()
	var mu sync.Mutex
	var order []string
	projectionReady := make(chan Projection, 1)
	worker, err := NewWorkerWithOptions(projection.Path, "claude", home, Callbacks{
		Preview: func(preview Preview) {
			if preview.Done {
				mu.Lock()
				order = append(order, "done")
				mu.Unlock()
			}
		},
		Projection: func(projected Projection) {
			mu.Lock()
			order = append(order, "projection")
			mu.Unlock()
			projectionReady <- projected
		},
	}, WorkerOptions{
		ProcessFactory: func(ProcessSpec) (Process, error) { return process, nil },
		Refresh:        catalog.RefreshNative, NativeExists: catalog.NativeExists,
		RefreshDelay: time.Millisecond, ConvergenceTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	promptDone := make(chan error, 1)
	go func() { promptDone <- worker.Prompt(context.Background(), chat.Request{Message: "question"}) }()
	_ = readFakeLine(t, process)
	process.emit(testInit(nativeID, cwd))
	if err := <-promptDone; err != nil {
		t.Fatal(err)
	}
	process.emit(`{"type":"assistant","session_id":"` + nativeID + `","message":{"id":"msg-authoritative","model":"haiku","role":"assistant","content":[{"type":"text","text":"answer"}]}}`)

	native := nativeRecord(nativeID, cwd, "question") +
		`{"type":"assistant","parentUuid":"00000000-0000-4000-8000-000000000151","cwd":` + compactJSON(cwd) + `,"sessionId":"` + nativeID + `","version":"2.1.215","message":{"id":"msg-authoritative","role":"assistant","model":"haiku","content":[{"type":"text","text":"answer"}]},"uuid":"00000000-0000-4000-8000-000000000152","timestamp":"2026-01-01T00:00:01Z"}` + "\n"
	writeNative(t, home, "-tmp-worker-refresh", nativeID, native)
	process.emit(`{"type":"result","subtype":"success","is_error":false,"session_id":"` + nativeID + `","result":"answer"}`)
	var refreshed Projection
	select {
	case refreshed = <-projectionReady:
	case <-time.After(time.Second):
		t.Fatal("projection did not converge")
	}
	waitWorkerState(t, worker, workers.WorkerStateIdle)
	mu.Lock()
	if strings.Join(order, ",") != "done,projection" {
		t.Fatalf("handoff order = %v", order)
	}
	mu.Unlock()
	parsed, err := sessions.ParseFile(refreshed.Path, filepath.Base(filepath.Dir(refreshed.Path)), filepath.Base(refreshed.Path))
	if err != nil {
		t.Fatal(err)
	}
	assistantEntries := 0
	for _, entry := range parsed.Entries {
		if entry["claudeMessageId"] == "msg-authoritative" {
			assistantEntries++
		}
	}
	if assistantEntries != 1 {
		t.Fatalf("authoritative assistant entries = %d, want 1", assistantEntries)
	}
	metadata, err := ReadProjectionMetadata(refreshed.Path)
	if err != nil || metadata.Fresh {
		t.Fatalf("refreshed metadata = %+v, %v", metadata, err)
	}
}
