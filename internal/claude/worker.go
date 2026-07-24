package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"pican/internal/chat"
	"pican/internal/projections"
	"pican/internal/workers"
)

const (
	maxStreamLineBytes           = 32 << 20
	maxWorkerStderrBytes         = 64 << 10
	defaultPreviewBytes          = 1 << 20
	defaultInitializationTimeout = 35 * time.Second
	defaultRefreshDelay          = 50 * time.Millisecond
	defaultRefreshTimeout        = 5 * time.Second
	defaultInterruptTimeout      = 2 * time.Second
)

var (
	ErrTurnInProgress = errors.New("Claude turn is already running")
	ErrUnsupported    = errors.New("Claude worker operation is unsupported")
)

type Preview struct {
	Content string `json:"content"`
	Done    bool   `json:"done"`
	TurnID  string `json:"turnId,omitempty"`
	ItemID  string `json:"itemId,omitempty"`
}

type Callbacks struct {
	Preview    func(Preview)
	Status     func(workers.WorkerStatus)
	Projection func(Projection)
	Error      func(error)
	Unknown    func(recordType string)
}

// ProjectionRefresh materializes the latest stable native transcript and says
// whether expectedMessageID is now authoritative. An empty expected ID means
// any stable transcript snapshot is sufficient (for example cancellation
// before an assistant message starts).
type ProjectionRefresh func(context.Context, string, string) (Projection, bool, error)

type WorkerOptions struct {
	ProcessFactory        ProcessFactory
	Refresh               ProjectionRefresh
	NativeExists          func(string) bool
	RefreshDelay          time.Duration
	ConvergenceTimeout    time.Duration
	InitializationTimeout time.Duration
	InterruptTimeout      time.Duration
	PreviewMaxBytes       int
}

type Worker struct {
	mu      sync.Mutex
	writeMu sync.Mutex

	process          Process
	stdin            io.WriteCloser
	nativeID         string
	cwd              string
	model            string
	fresh            bool
	status           workers.WorkerStatus
	callbacks        Callbacks
	refresh          ProjectionRefresh
	refreshDelay     time.Duration
	refreshTimeout   time.Duration
	initTimeout      time.Duration
	interruptTimeout time.Duration
	previewMaxBytes  int
	startedAt        time.Time
	lastActive       time.Time

	initialized bool
	initOnce    sync.Once
	initResult  chan error
	turnSeq     uint64
	turnID      string
	messageID   string
	previewText strings.Builder
	turnError   string
	converging  bool
	fatal       bool
	closing     bool

	controlSeq uint64
	controls   map[string]chan error
	stderr     *boundedWorkerBuffer
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
	background sync.WaitGroup
}

var _ workers.ChatWorker = (*Worker)(nil)

func NewWorker(sessionPath, command, home string, catalog *Catalog, callbacks Callbacks) (*Worker, error) {
	options := WorkerOptions{}
	if catalog != nil {
		options.Refresh = catalog.RefreshNative
		options.NativeExists = catalog.NativeExists
	}
	return NewWorkerWithOptions(sessionPath, command, home, callbacks, options)
}

func NewWorkerWithOptions(sessionPath, command, home string, callbacks Callbacks, options WorkerOptions) (*Worker, error) {
	metadata, err := ReadProjectionMetadata(sessionPath)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(command) == "" {
		return nil, errors.New("Claude command is required")
	}
	fresh := metadata.Fresh
	if fresh && options.NativeExists != nil && options.NativeExists(metadata.NativeID) {
		fresh = false
	}
	factory := options.ProcessFactory
	if factory == nil {
		factory = newExecProcess
	}
	refreshDelay := options.RefreshDelay
	if refreshDelay <= 0 {
		refreshDelay = defaultRefreshDelay
	}
	refreshTimeout := options.ConvergenceTimeout
	if refreshTimeout <= 0 {
		refreshTimeout = defaultRefreshTimeout
	}
	initTimeout := options.InitializationTimeout
	if initTimeout <= 0 {
		initTimeout = defaultInitializationTimeout
	}
	interruptTimeout := options.InterruptTimeout
	if interruptTimeout <= 0 {
		interruptTimeout = defaultInterruptTimeout
	}
	previewMaxBytes := options.PreviewMaxBytes
	if previewMaxBytes <= 0 {
		previewMaxBytes = defaultPreviewBytes
	}
	if _, err := nativeIDFromPath(metadata.NativeID + ".jsonl"); err != nil {
		return nil, fmt.Errorf("invalid Claude projection native id: %w", err)
	}
	spec := ProcessSpec{
		Command: command,
		Args:    BuildWorkerArgs(metadata.NativeID, metadata.Model, fresh),
		Env:     workerCommandEnv(home),
		Dir:     metadata.CWD,
	}
	process, err := factory(spec)
	if err != nil {
		return nil, fmt.Errorf("create Claude process: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	now := time.Now()
	worker := &Worker{
		process: process, stdin: process.Stdin(), nativeID: metadata.NativeID,
		cwd: metadata.CWD, model: metadata.Model, fresh: fresh,
		status:    workers.WorkerStatus{State: workers.WorkerStateIdle, Model: metadata.Model, ModelProvider: Provider},
		callbacks: callbacks, refresh: options.Refresh, refreshDelay: refreshDelay,
		refreshTimeout: refreshTimeout, initTimeout: initTimeout,
		interruptTimeout: interruptTimeout, previewMaxBytes: previewMaxBytes,
		startedAt: now, lastActive: now,
		initResult: make(chan error, 1), controls: make(map[string]chan error),
		stderr: &boundedWorkerBuffer{max: maxWorkerStderrBytes}, ctx: ctx, cancel: cancel,
		done: make(chan struct{}),
	}
	if err := process.Start(); err != nil {
		cancel()
		_ = worker.stdin.Close()
		return nil, fmt.Errorf("start Claude: %w", err)
	}
	worker.background.Add(3)
	go func() {
		defer worker.background.Done()
		worker.consume(process.Stdout())
	}()
	go func() {
		defer worker.background.Done()
		_, _ = io.Copy(worker.stderr, process.Stderr())
	}()
	go func() {
		defer worker.background.Done()
		worker.waitProcess()
	}()
	return worker, nil
}

func BuildWorkerArgs(nativeID, model string, fresh bool) []string {
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--dangerously-skip-permissions",
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	if fresh {
		return append(args, "--session-id", nativeID)
	}
	return append(args, "--resume", nativeID)
}

func workerCommandEnv(home string) []string { return oauthCommandEnv(home) }

func (w *Worker) Prompt(ctx context.Context, request chat.Request) error {
	content, err := claudeInputContent(request)
	if err != nil {
		return err
	}
	frame, err := marshalStreamFrame(map[string]any{
		"type":    "user",
		"message": map[string]any{"role": "user", "content": content},
	})
	if err != nil {
		return err
	}

	// Own the stream before publishing Running. Abort observes Running under
	// mu, then waits on writeMu, which guarantees the user frame reaches stdin
	// before any interrupt accepted for that turn.
	w.writeMu.Lock()
	w.mu.Lock()
	if w.fatal {
		err := errors.New(w.status.Error)
		w.mu.Unlock()
		w.writeMu.Unlock()
		return err
	}
	if w.closing {
		w.mu.Unlock()
		w.writeMu.Unlock()
		return errors.New("Claude worker is closed")
	}
	if w.status.State == workers.WorkerStateRunning {
		w.mu.Unlock()
		w.writeMu.Unlock()
		return ErrTurnInProgress
	}
	w.turnSeq++
	w.turnID = fmt.Sprintf("claude-turn-%d", w.turnSeq)
	w.messageID = ""
	w.previewText.Reset()
	w.turnError = ""
	w.converging = false
	firstPrompt := !w.initialized
	w.lastActive = time.Now()
	w.status = workers.WorkerStatus{State: workers.WorkerStateRunning, Model: w.model, ModelProvider: Provider}
	status := w.status
	w.mu.Unlock()
	writeErr := writeFull(w.stdin, frame)
	w.writeMu.Unlock()
	if writeErr != nil {
		wrapped := fmt.Errorf("write Claude prompt: %w", writeErr)
		w.protocolError(wrapped)
		return wrapped
	}
	w.publishStatus(status)

	if !firstPrompt {
		return nil
	}
	timer := time.NewTimer(w.initTimeout)
	defer timer.Stop()
	select {
	case err := <-w.initResult:
		return err
	case <-timer.C:
		timeoutErr := fmt.Errorf("Claude initialization timed out: %w", context.DeadlineExceeded)
		killErr := w.process.Kill()
		if killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
			timeoutErr = errors.Join(timeoutErr, fmt.Errorf("terminate Claude process tree: %w", killErr))
		}
		w.protocolError(timeoutErr)
		return timeoutErr
	case <-ctx.Done():
		return ctx.Err()
	case <-w.ctx.Done():
		select {
		case err := <-w.initResult:
			return err
		default:
			return errors.New("Claude worker stopped before initialization")
		}
	}
}

func claudeInputContent(request chat.Request) ([]any, error) {
	content := make([]any, 0, 1+len(request.Images))
	if request.Message != "" {
		content = append(content, map[string]any{"type": "text", "text": request.Message})
	}
	for _, image := range request.Images {
		switch image.MimeType {
		case "image/jpeg", "image/png", "image/gif", "image/webp":
		default:
			return nil, fmt.Errorf("Claude does not support image type %q", image.MimeType)
		}
		if image.Data == "" {
			return nil, errors.New("Claude image data is required")
		}
		decoder := base64.NewDecoder(base64.StdEncoding.Strict(), strings.NewReader(image.Data))
		if _, err := io.Copy(io.Discard, decoder); err != nil {
			return nil, fmt.Errorf("invalid Claude image data: %w", err)
		}
		content = append(content, map[string]any{
			"type": "image",
			"source": map[string]any{
				"type": "base64", "media_type": image.MimeType, "data": image.Data,
			},
		})
	}
	if len(content) == 0 {
		return nil, errors.New("Claude prompt requires text or an image")
	}
	return content, nil
}

func (w *Worker) SetModel(context.Context, string, string) error              { return ErrUnsupported }
func (w *Worker) SetThinkingLevel(context.Context, string) error              { return ErrUnsupported }
func (w *Worker) GetCommands(context.Context) ([]workers.SlashCommand, error) { return nil, nil }
func (w *Worker) GetState(context.Context) (workers.WorkerStatus, error)      { return w.Status(), nil }

func (w *Worker) Abort(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	w.mu.Lock()
	if w.status.State != workers.WorkerStateRunning || w.fatal || w.closing {
		w.mu.Unlock()
		return nil
	}
	w.controlSeq++
	requestID := fmt.Sprintf("pican-interrupt-%d", w.controlSeq)
	result := make(chan error, 1)
	w.controls[requestID] = result
	w.lastActive = time.Now()
	w.mu.Unlock()

	command := map[string]any{
		"type": "control_request", "request_id": requestID,
		"request": map[string]any{"subtype": "interrupt"},
	}
	if err := w.writeLine(command); err != nil {
		w.removeControl(requestID)
		w.protocolError(fmt.Errorf("write Claude interrupt: %w", err))
		return err
	}
	timer := time.NewTimer(w.interruptTimeout)
	defer timer.Stop()
	select {
	case err := <-result:
		return err
	case <-timer.C:
		w.removeControl(requestID)
		timeoutErr := context.DeadlineExceeded
		killErr := w.process.Kill()
		if errors.Is(killErr, os.ErrProcessDone) {
			killErr = nil
		}
		fatalErr := fmt.Errorf("Claude interrupt timed out: %w", timeoutErr)
		if killErr != nil {
			fatalErr = errors.Join(fatalErr, fmt.Errorf("terminate Claude process tree: %w", killErr))
		}
		w.protocolError(fatalErr)
		return timeoutErr
	case <-w.ctx.Done():
		w.mu.Lock()
		message := w.status.Error
		w.mu.Unlock()
		if message != "" {
			return errors.New(message)
		}
		return errors.New("Claude worker stopped during interrupt")
	}
}

func (w *Worker) Status() workers.WorkerStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status
}

func (w *Worker) PID() int             { return w.process.PID() }
func (w *Worker) StartedAt() time.Time { return w.startedAt }
func (w *Worker) IdleSince(now time.Time) time.Duration {
	w.mu.Lock()
	defer w.mu.Unlock()
	return now.Sub(w.lastActive)
}

func (w *Worker) Close() error {
	w.mu.Lock()
	if w.closing {
		done := w.done
		w.mu.Unlock()
		<-done
		w.background.Wait()
		return nil
	}
	w.closing = true
	w.cancel()
	w.failPendingLocked(errors.New("Claude worker closed"))
	w.mu.Unlock()
	if w.stdin != nil {
		_ = w.stdin.Close()
	}
	err := w.process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		err = nil
	}
	<-w.done
	w.background.Wait()
	return err
}

func (w *Worker) writeLine(value any) error {
	data, err := marshalStreamFrame(value)
	if err != nil {
		return err
	}
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	return writeFull(w.stdin, data)
}

func marshalStreamFrame(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func writeFull(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		written, err := writer.Write(data)
		if written > 0 {
			data = data[written:]
		}
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func (w *Worker) consume(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64<<10), maxStreamLineBytes)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		if err := w.handleLine(append([]byte(nil), line...)); err != nil {
			w.protocolError(err)
			_ = w.process.Kill()
			return
		}
	}
	if err := scanner.Err(); err != nil {
		w.protocolError(fmt.Errorf("Claude stdout: %w", err))
		_ = w.process.Kill()
	}
}

func (w *Worker) handleLine(line []byte) error {
	var envelope struct {
		Type      string          `json:"type"`
		Subtype   string          `json:"subtype"`
		SessionID string          `json:"session_id"`
		Raw       json.RawMessage `json:"-"`
	}
	if err := json.Unmarshal(line, &envelope); err != nil {
		return fmt.Errorf("invalid Claude stream-json line: %w", err)
	}
	if envelope.Type == "" {
		return errors.New("invalid Claude stream-json record without type")
	}
	if envelope.SessionID != "" && envelope.SessionID != w.nativeID {
		return fmt.Errorf("Claude native session id mismatch: got %q, want %q", envelope.SessionID, w.nativeID)
	}
	if streamRecordRequiresSessionID(envelope.Type) && envelope.SessionID == "" {
		return fmt.Errorf("invalid Claude %s record without session_id", envelope.Type)
	}
	switch envelope.Type {
	case "system":
		switch envelope.Subtype {
		case "init":
			return w.handleInit(line)
		case "status":
			var status struct {
				Status string `json:"status"`
			}
			if err := json.Unmarshal(line, &status); err != nil {
				return err
			}
			if status.Status == "" {
				return errors.New("invalid Claude system status record")
			}
		default:
			if envelope.Subtype == "" {
				return errors.New("invalid Claude system record without subtype")
			}
			w.publishUnknown(envelope.Type + ":" + envelope.Subtype)
		}
	case "stream_event":
		return w.handleStreamEvent(line)
	case "assistant":
		return w.handleAssistant(line)
	case "result":
		return w.handleResult(line)
	case "error":
		return w.handleErrorRecord(line)
	case "control_response":
		return w.handleControlResponse(line)
	default:
		w.publishUnknown(envelope.Type)
	}
	return nil
}

func streamRecordRequiresSessionID(recordType string) bool {
	switch recordType {
	case "system", "stream_event", "assistant", "result", "error":
		return true
	default:
		return false
	}
}

func (w *Worker) requireActiveTurn(recordType string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.initialized {
		return fmt.Errorf("Claude %s record arrived before initialization", recordType)
	}
	if w.status.State != workers.WorkerStateRunning {
		return fmt.Errorf("Claude %s record arrived without an active turn", recordType)
	}
	return nil
}

func (w *Worker) handleInit(line []byte) error {
	var init struct {
		SessionID      string `json:"session_id"`
		CWD            string `json:"cwd"`
		Model          string `json:"model"`
		PermissionMode string `json:"permissionMode"`
	}
	if err := json.Unmarshal(line, &init); err != nil {
		return err
	}
	if init.SessionID == "" || init.SessionID != w.nativeID {
		return fmt.Errorf("Claude init native session id mismatch: got %q, want %q", init.SessionID, w.nativeID)
	}
	if init.CWD == "" || projections.CanonicalCWD(init.CWD) != projections.CanonicalCWD(w.cwd) {
		return fmt.Errorf("Claude init cwd mismatch: got %q, want %q", init.CWD, w.cwd)
	}
	if init.PermissionMode != "bypassPermissions" {
		return fmt.Errorf("Claude init permission mode %q is not bypassPermissions", init.PermissionMode)
	}
	w.mu.Lock()
	if w.status.State != workers.WorkerStateRunning {
		w.mu.Unlock()
		return errors.New("Claude init arrived without an active turn")
	}
	w.initialized = true
	if init.Model != "" {
		w.model = init.Model
		w.status.Model = init.Model
	}
	status := w.status
	w.mu.Unlock()
	w.initOnce.Do(func() { w.initResult <- nil })
	w.publishStatus(status)
	return nil
}

func (w *Worker) handleStreamEvent(line []byte) error {
	if err := w.requireActiveTurn("stream_event"); err != nil {
		return err
	}
	var record struct {
		Event struct {
			Type    string `json:"type"`
			Message struct {
				ID string `json:"id"`
			} `json:"message"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
		} `json:"event"`
	}
	if err := json.Unmarshal(line, &record); err != nil {
		return err
	}
	if record.Event.Type == "" {
		return errors.New("invalid Claude stream_event without event type")
	}
	switch record.Event.Type {
	case "message_start":
		if record.Event.Message.ID == "" {
			return errors.New("invalid Claude message_start without message id")
		}
		w.mu.Lock()
		w.messageID = record.Event.Message.ID
		w.mu.Unlock()
	case "content_block_delta":
		switch record.Event.Delta.Type {
		case "text_delta":
			if record.Event.Delta.Text != "" {
				w.appendPreview(record.Event.Delta.Text)
			}
		case "thinking_delta", "signature_delta", "input_json_delta":
			// These remain transient native detail; the file-backed projection
			// authoritatively renders thinking and tool input.
		default:
			if record.Event.Delta.Type == "" {
				return errors.New("invalid Claude content_block_delta without delta type")
			}
			w.publishUnknown("stream_event:content_block_delta:" + record.Event.Delta.Type)
		}
	case "content_block_start", "content_block_stop", "message_delta", "message_stop":
		// Ordering/status records carry no assistant text of their own.
	default:
		w.publishUnknown("stream_event:" + record.Event.Type)
	}
	return nil
}

func (w *Worker) handleAssistant(line []byte) error {
	if err := w.requireActiveTurn("assistant"); err != nil {
		return err
	}
	var record struct {
		Message struct {
			ID      string          `json:"id"`
			Model   string          `json:"model"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(line, &record); err != nil {
		return err
	}
	if record.Message.ID == "" {
		return errors.New("invalid Claude assistant record without message id")
	}
	var blocks []map[string]json.RawMessage
	if err := json.Unmarshal(record.Message.Content, &blocks); err != nil || blocks == nil {
		return errors.New("invalid Claude assistant content")
	}
	var text strings.Builder
	for _, block := range blocks {
		if rawString(block["type"]) == "text" {
			text.WriteString(rawString(block["text"]))
		}
	}
	w.mu.Lock()
	w.messageID = record.Message.ID
	if record.Message.Model != "" {
		w.model = record.Message.Model
		w.status.Model = record.Message.Model
	}
	if text.Len() > 0 && boundedUTF8Prefix(text.String(), w.previewMaxBytes) != w.previewText.String() {
		w.previewText.Reset()
		w.previewText.WriteString(boundedUTF8Prefix(text.String(), w.previewMaxBytes))
	}
	preview := Preview{Content: w.previewText.String(), TurnID: w.turnID, ItemID: w.messageID}
	status := w.status
	w.mu.Unlock()
	if preview.Content != "" && w.callbacks.Preview != nil {
		w.callbacks.Preview(preview)
	}
	w.publishStatus(status)
	return nil
}

func (w *Worker) appendPreview(delta string) {
	w.mu.Lock()
	remaining := w.previewMaxBytes - w.previewText.Len()
	if remaining <= 0 {
		w.mu.Unlock()
		return
	}
	w.previewText.WriteString(boundedUTF8Prefix(delta, remaining))
	preview := Preview{Content: w.previewText.String(), TurnID: w.turnID, ItemID: w.messageID}
	w.mu.Unlock()
	if w.callbacks.Preview != nil {
		w.callbacks.Preview(preview)
	}
}

func boundedUTF8Prefix(value string, maxBytes int) string {
	if maxBytes <= 0 {
		return ""
	}
	if len(value) <= maxBytes {
		return value
	}
	end := maxBytes
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end]
}

func (w *Worker) handleResult(line []byte) error {
	if err := w.requireActiveTurn("result"); err != nil {
		return err
	}
	var result struct {
		Subtype        string   `json:"subtype"`
		IsError        bool     `json:"is_error"`
		Result         string   `json:"result"`
		Error          string   `json:"error"`
		Errors         []string `json:"errors"`
		TerminalReason string   `json:"terminal_reason"`
	}
	if err := json.Unmarshal(line, &result); err != nil {
		return err
	}
	if result.Subtype == "" {
		return errors.New("invalid Claude result without subtype")
	}
	w.mu.Lock()
	if w.converging {
		w.mu.Unlock()
		return nil
	}
	w.converging = true
	generation := w.turnSeq
	expectedMessageID := w.messageID
	if !result.IsError && result.Subtype == "success" && expectedMessageID == "" {
		w.converging = false
		w.mu.Unlock()
		return errors.New("Claude successful result arrived without an assistant message id")
	}
	if w.previewText.Len() == 0 && !result.IsError && strings.TrimSpace(result.Result) != "" {
		w.previewText.WriteString(boundedUTF8Prefix(result.Result, w.previewMaxBytes))
	}
	if result.IsError || result.Subtype != "success" {
		message := strings.TrimSpace(result.Error)
		if message == "" && len(result.Errors) > 0 {
			message = strings.TrimSpace(strings.Join(result.Errors, "; "))
		}
		if message == "" {
			message = strings.TrimSpace(result.Result)
		}
		if message == "" {
			message = strings.TrimSpace(result.TerminalReason)
		}
		if message == "" {
			message = "Claude turn failed: " + result.Subtype
		}
		w.turnError = message
	}
	w.mu.Unlock()
	w.background.Add(1)
	go func() {
		defer w.background.Done()
		w.converge(generation, expectedMessageID)
	}()
	return nil
}

func (w *Worker) handleErrorRecord(line []byte) error {
	if err := w.requireActiveTurn("error"); err != nil {
		return err
	}
	var record struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(line, &record); err != nil {
		return err
	}
	message := strings.TrimSpace(record.Error)
	if message == "" {
		message = strings.TrimSpace(record.Message)
	}
	if message == "" {
		return errors.New("invalid Claude error record without an error message")
	}
	w.mu.Lock()
	w.turnError = message
	w.mu.Unlock()
	if w.callbacks.Error != nil {
		w.callbacks.Error(errors.New(message))
	}
	return nil
}

func (w *Worker) handleControlResponse(line []byte) error {
	var record struct {
		RequestID string `json:"request_id"`
		Subtype   string `json:"subtype"`
		Response  struct {
			RequestID string `json:"request_id"`
			Subtype   string `json:"subtype"`
			Error     string `json:"error"`
		} `json:"response"`
	}
	if err := json.Unmarshal(line, &record); err != nil {
		return err
	}
	requestID := record.RequestID
	if requestID == "" {
		requestID = record.Response.RequestID
	}
	subtype := record.Subtype
	if subtype == "" {
		subtype = record.Response.Subtype
	}
	if requestID == "" || subtype == "" {
		return errors.New("invalid Claude control_response")
	}
	var err error
	if subtype != "success" {
		message := record.Response.Error
		if message == "" {
			message = "Claude interrupt was rejected"
		}
		err = errors.New(message)
	}
	w.mu.Lock()
	result := w.controls[requestID]
	delete(w.controls, requestID)
	w.mu.Unlock()
	if result != nil {
		result <- err
	} else {
		w.publishUnknown("control_response:" + requestID)
	}
	return nil
}

func (w *Worker) converge(generation uint64, expectedMessageID string) {
	ctx, cancel := context.WithTimeout(w.ctx, w.refreshTimeout)
	defer cancel()
	var lastErr error
	for {
		if w.refresh == nil {
			w.finishTurn(generation, Projection{}, false, nil)
			return
		}
		projection, ready, err := w.refresh(ctx, w.nativeID, expectedMessageID)
		if err != nil {
			lastErr = err
		} else if ready {
			w.finishTurn(generation, projection, true, nil)
			return
		}
		timer := time.NewTimer(w.refreshDelay)
		select {
		case <-ctx.Done():
			timer.Stop()
			if lastErr == nil {
				lastErr = errors.New("Claude transcript did not converge before timeout")
			}
			w.finishTurn(generation, Projection{}, false, lastErr)
			return
		case <-timer.C:
		}
	}
}

func (w *Worker) finishTurn(generation uint64, projection Projection, projected bool, convergenceErr error) {
	w.mu.Lock()
	if w.closing || w.fatal || generation != w.turnSeq {
		w.mu.Unlock()
		return
	}
	turnErr := w.turnError
	if convergenceErr != nil && turnErr == "" {
		turnErr = convergenceErr.Error()
	}
	preview := Preview{Content: w.previewText.String(), Done: true, TurnID: w.turnID, ItemID: w.messageID}
	w.status = workers.WorkerStatus{State: workers.WorkerStateIdle, Error: turnErr, Model: w.model, ModelProvider: Provider}
	w.lastActive = time.Now()
	status := w.status
	w.mu.Unlock()

	// The projection has already been atomically written by Refresh. Mark the
	// transient preview done before broadcasting reload so the browser removes
	// it as soon as the matching authoritative Claude message appears.
	if w.callbacks.Preview != nil {
		w.callbacks.Preview(preview)
	}
	if projected && w.callbacks.Projection != nil {
		w.callbacks.Projection(projection)
	}
	w.publishStatus(status)
	if convergenceErr != nil && w.callbacks.Error != nil {
		w.callbacks.Error(convergenceErr)
	}
}

func (w *Worker) waitProcess() {
	err := w.process.Wait()
	exitCode := w.process.ExitCode()
	w.mu.Lock()
	closing := w.closing
	w.mu.Unlock()
	if !closing {
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		w.protocolError(w.withStderr(fmt.Errorf("Claude process exited: %w", err)))
		w.mu.Lock()
		if w.status.ExitCode == nil {
			w.status.ExitCode = &exitCode
		}
		status := w.status
		w.mu.Unlock()
		w.publishStatus(status)
	}
	close(w.done)
}

func (w *Worker) protocolError(err error) {
	if err == nil {
		return
	}
	err = w.withStderr(err)
	w.mu.Lock()
	if w.fatal || w.closing {
		w.mu.Unlock()
		return
	}
	w.fatal = true
	w.cancel()
	w.status = workers.WorkerStatus{State: workers.WorkerStateError, Error: err.Error(), Model: w.model, ModelProvider: Provider}
	w.failPendingLocked(err)
	status := w.status
	w.mu.Unlock()
	w.initOnce.Do(func() { w.initResult <- err })
	w.publishStatus(status)
	if w.callbacks.Error != nil {
		w.callbacks.Error(err)
	}
}

func (w *Worker) failPendingLocked(err error) {
	for id, result := range w.controls {
		delete(w.controls, id)
		result <- err
	}
}

func (w *Worker) removeControl(id string) {
	w.mu.Lock()
	delete(w.controls, id)
	w.mu.Unlock()
}

func (w *Worker) publishStatus(status workers.WorkerStatus) {
	if w.callbacks.Status != nil {
		w.callbacks.Status(status)
	}
}

func (w *Worker) publishUnknown(recordType string) {
	if w.callbacks.Unknown != nil {
		w.callbacks.Unknown(recordType)
	}
}

func (w *Worker) withStderr(err error) error {
	stderr := strings.TrimSpace(w.stderr.String())
	if stderr == "" || strings.Contains(err.Error(), "stderr:") {
		return err
	}
	return fmt.Errorf("%w; stderr: %s", err, stderr)
}

type boundedWorkerBuffer struct {
	mu   sync.Mutex
	data []byte
	max  int
}

func (b *boundedWorkerBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if len(b.data) > b.max {
		b.data = append([]byte(nil), b.data[len(b.data)-b.max:]...)
	}
	return len(p), nil
}

func (b *boundedWorkerBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.data)
}
