package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"pican/internal/chat"
	"pican/internal/workers"
)

const (
	defaultWorkerPreviewBytes   = 1 << 20
	defaultWorkerRefreshTimeout = 10 * time.Second
)

var (
	ErrTurnInProgress = errors.New("OpenCode turn is already running")
	ErrUnsupported    = errors.New("OpenCode worker operation is unsupported")
)

type Preview struct {
	Content string `json:"content"`
	Done    bool   `json:"done"`
	TurnID  string `json:"turnId,omitempty"`
	ItemID  string `json:"itemId,omitempty"`
}

type WorkerCallbacks struct {
	Preview    func(Preview)
	Status     func(workers.WorkerStatus)
	Projection func(Projection)
	Error      func(error)
}

type WorkerOptions struct {
	Supervisor      *Supervisor
	Refresh         func(context.Context, string, string) (Projection, error)
	PreviewMaxBytes int
	RefreshTimeout  time.Duration
}

// Worker is a lightweight native-session attachment to the supervisor's one
// child process and global SSE stream.
type Worker struct {
	mu sync.Mutex

	supervisor     *Supervisor
	refresh        func(context.Context, string, string) (Projection, error)
	callbacks      WorkerCallbacks
	nativeID       string
	cwd            string
	sessionPath    string
	model          string
	status         workers.WorkerStatus
	preview        string
	previewMax     int
	refreshTimeout time.Duration
	startedAt      time.Time
	lastActive     time.Time
	closed         bool
	refreshing     bool
	refreshAgain   bool
	background     sync.WaitGroup

	events                  <-chan Event
	unsubscribe             func()
	availability            <-chan Availability
	unsubscribeAvailability func()
	ctx                     context.Context
	cancel                  context.CancelFunc
	done                    chan struct{}
}

var _ workers.ChatWorker = (*Worker)(nil)

func NewWorker(sessionPath string, supervisor *Supervisor, refresh func(context.Context, string, string) (Projection, error), callbacks WorkerCallbacks) (*Worker, error) {
	return NewWorkerWithOptions(sessionPath, callbacks, WorkerOptions{Supervisor: supervisor, Refresh: refresh})
}

func NewWorkerWithOptions(sessionPath string, callbacks WorkerCallbacks, options WorkerOptions) (*Worker, error) {
	if options.Supervisor == nil {
		return nil, errors.New("OpenCode worker requires a supervisor")
	}
	if _, err := options.Supervisor.Client(); err != nil {
		return nil, err
	}
	metadata, err := ReadProjectionMetadata(sessionPath)
	if err != nil {
		return nil, err
	}
	cwd, err := CanonicalDirectory(metadata.CWD)
	if err != nil {
		return nil, err
	}
	if metadata.Model != "" {
		if _, _, err := ParseModelID(metadata.Model); err != nil {
			return nil, fmt.Errorf("invalid OpenCode projection model: %w", err)
		}
	}
	previewMax := options.PreviewMaxBytes
	if previewMax <= 0 {
		previewMax = defaultWorkerPreviewBytes
	}
	refreshTimeout := options.RefreshTimeout
	if refreshTimeout <= 0 {
		refreshTimeout = defaultWorkerRefreshTimeout
	}
	events, unsubscribe := options.Supervisor.Subscribe(metadata.NativeID)
	availability, unsubscribeAvailability := options.Supervisor.SubscribeAvailability()
	ctx, cancel := context.WithCancel(context.Background())
	now := time.Now()
	worker := &Worker{
		supervisor: options.Supervisor, refresh: options.Refresh, callbacks: callbacks,
		nativeID: metadata.NativeID, cwd: cwd, sessionPath: sessionPath, model: metadata.Model,
		status:     workers.WorkerStatus{State: workers.WorkerStateIdle, Model: metadata.Model, ModelProvider: Provider},
		previewMax: previewMax, refreshTimeout: refreshTimeout, startedAt: now, lastActive: now,
		events: events, unsubscribe: unsubscribe, availability: availability,
		unsubscribeAvailability: unsubscribeAvailability, ctx: ctx, cancel: cancel, done: make(chan struct{}),
	}
	worker.background.Add(1)
	go func() {
		defer worker.background.Done()
		worker.run()
	}()
	return worker, nil
}

func (w *Worker) run() {
	defer close(w.done)
	for {
		select {
		case event, ok := <-w.events:
			if !ok {
				return
			}
			w.handleEvent(event)
		case availability, ok := <-w.availability:
			if !ok {
				return
			}
			if !availability.Available && availability.Err != nil {
				w.fatal(fmt.Errorf("OpenCode runtime unavailable: %w", availability.Err))
			}
		case <-w.ctx.Done():
			return
		}
	}
}

func (w *Worker) Prompt(ctx context.Context, request chat.Request) error {
	if len(request.Images) != 0 {
		return errors.New("OpenCode attachments are unsupported")
	}
	message := strings.TrimSpace(request.Message)
	if message == "" {
		return chat.ErrEmptyRequest
	}
	client, err := w.supervisor.Client()
	if err != nil {
		return w.operationError(err)
	}
	statuses, err := client.Status(ctx, w.cwd)
	if err != nil {
		return w.operationError(err)
	}
	if native, busy := statuses[w.nativeID]; busy && native.Type != "" && native.Type != "idle" {
		return ErrTurnInProgress
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return errors.New("OpenCode worker is closed")
	}
	if w.status.State == workers.WorkerStateError {
		err := errors.New(w.status.Error)
		w.mu.Unlock()
		return err
	}
	if w.status.State == workers.WorkerStateRunning {
		w.mu.Unlock()
		return ErrTurnInProgress
	}
	model := w.model
	w.preview = ""
	w.lastActive = time.Now()
	w.status = workers.WorkerStatus{State: workers.WorkerStateRunning, Model: model, ModelProvider: Provider}
	status := w.status
	w.mu.Unlock()
	w.publishStatus(status)

	prompt := PromptRequest{Parts: []PromptPart{{Type: "text", Text: message}}}
	if model != "" {
		providerID, modelID, err := ParseModelID(model)
		if err != nil {
			return w.operationError(err)
		}
		prompt.Model = &PromptModelRef{ProviderID: providerID, ModelID: modelID}
	}
	if err := client.PromptAsync(ctx, w.nativeID, w.cwd, prompt); err != nil {
		return w.operationError(err)
	}
	return nil
}

func (w *Worker) SetModel(_ context.Context, provider, modelID string) error {
	if provider != "" && provider != Provider {
		return fmt.Errorf("OpenCode worker requires provider %q", Provider)
	}
	if _, _, err := ParseModelID(modelID); err != nil {
		return err
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return errors.New("OpenCode worker is closed")
	}
	if w.status.State == workers.WorkerStateRunning {
		w.mu.Unlock()
		return errors.New("OpenCode model cannot change during a running turn")
	}
	if err := SetProjectionModel(w.sessionPath, modelID, nil); err != nil {
		w.mu.Unlock()
		return err
	}
	w.model = modelID
	w.lastActive = time.Now()
	w.status.Model = modelID
	status := w.status
	w.mu.Unlock()
	w.publishStatus(status)
	return nil
}

func (w *Worker) SetThinkingLevel(context.Context, string) error {
	return fmt.Errorf("%w: reasoning selection", ErrUnsupported)
}

func (w *Worker) Abort(ctx context.Context) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return errors.New("OpenCode worker is closed")
	}
	running := w.status.State == workers.WorkerStateRunning
	w.lastActive = time.Now()
	w.mu.Unlock()
	if !running {
		return nil
	}
	client, err := w.supervisor.Client()
	if err != nil {
		return w.abortError(err)
	}
	aborted, err := client.Abort(ctx, w.nativeID, w.cwd)
	if err != nil {
		return w.abortError(err)
	}
	if !aborted {
		return w.abortError(errors.New("OpenCode refused to abort the running session"))
	}
	w.finishTurn("")
	return nil
}

func (w *Worker) GetState(ctx context.Context) (workers.WorkerStatus, error) {
	client, err := w.supervisor.Client()
	if err != nil {
		return w.Status(), err
	}
	statuses, err := client.Status(ctx, w.cwd)
	if err != nil {
		return w.Status(), err
	}
	native, busy := statuses[w.nativeID]
	if busy && native.Type != "" && native.Type != "idle" {
		w.mu.Lock()
		if !w.closed && w.status.State != workers.WorkerStateError {
			w.status = workers.WorkerStatus{
				State: workers.WorkerStateRunning, Error: native.Message,
				Model: w.model, ModelProvider: Provider,
			}
		}
		status := w.status
		w.mu.Unlock()
		w.publishStatus(status)
		return status, nil
	}
	w.mu.Lock()
	wasRunning := w.status.State == workers.WorkerStateRunning
	w.mu.Unlock()
	if wasRunning {
		w.finishTurn("")
	}
	return w.Status(), nil
}
func (w *Worker) GetCommands(context.Context) ([]workers.SlashCommand, error) {
	return nil, fmt.Errorf("%w: slash commands", ErrUnsupported)
}

func (w *Worker) Status() workers.WorkerStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status
}

// PID is the shared child PID. Multiple OpenCode worker snapshots therefore
// intentionally report the same process rather than inventing per-session
// processes.
func (w *Worker) PID() int             { return w.supervisor.PID() }
func (w *Worker) StartedAt() time.Time { return w.supervisor.StartedAt() }
func (w *Worker) IdleSince(now time.Time) time.Duration {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.status.State != workers.WorkerStateIdle {
		return 0
	}
	return now.Sub(w.lastActive)
}

func (w *Worker) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	w.mu.Unlock()
	w.cancel()
	w.unsubscribe()
	w.unsubscribeAvailability()
	<-w.done
	w.background.Wait()
	return nil
}

func (w *Worker) handleEvent(event Event) {
	if event.SessionID() != w.nativeID {
		return
	}
	eventDirectory, err := CanonicalDirectory(event.Directory)
	if err != nil || eventDirectory != w.cwd {
		return
	}
	switch event.Payload.Type {
	case "message.part.delta":
		var properties struct {
			MessageID string `json:"messageID"`
			PartID    string `json:"partID"`
			Delta     string `json:"delta"`
		}
		if json.Unmarshal(event.Payload.Properties, &properties) == nil && properties.Delta != "" {
			w.appendPreview(properties.MessageID, properties.PartID, properties.Delta)
		}
	case "message.part.updated":
		var properties struct {
			Part Part `json:"part"`
		}
		if json.Unmarshal(event.Payload.Properties, &properties) == nil && properties.Part.Type == "text" && properties.Part.Text != "" {
			w.replacePreview(properties.Part.MessageID, properties.Part.ID, properties.Part.Text)
		}
		w.scheduleRefresh()
	case "message.updated", "session.updated":
		w.scheduleRefresh()
	case "session.idle":
		w.finishTurn("")
	case "session.status":
		var properties struct {
			Status SessionStatus `json:"status"`
		}
		if json.Unmarshal(event.Payload.Properties, &properties) == nil && properties.Status.Type == "idle" {
			w.finishTurn("")
		}
	case "session.error":
		var properties struct {
			Error json.RawMessage `json:"error"`
		}
		_ = json.Unmarshal(event.Payload.Properties, &properties)
		message := strings.TrimSpace(string(properties.Error))
		if message == "" || message == "null" {
			message = "OpenCode turn failed"
		}
		w.finishTurn(message)
	}
}

func (w *Worker) appendPreview(turnID, itemID, delta string) {
	w.mu.Lock()
	if w.closed || w.status.State != workers.WorkerStateRunning {
		w.mu.Unlock()
		return
	}
	w.preview = boundedUTF8(w.preview+delta, w.previewMax)
	preview := Preview{Content: w.preview, TurnID: turnID, ItemID: itemID}
	w.mu.Unlock()
	w.publishPreview(preview)
}

func (w *Worker) replacePreview(turnID, itemID, content string) {
	w.mu.Lock()
	if w.closed || w.status.State != workers.WorkerStateRunning {
		w.mu.Unlock()
		return
	}
	w.preview = boundedUTF8(content, w.previewMax)
	preview := Preview{Content: w.preview, TurnID: turnID, ItemID: itemID}
	w.mu.Unlock()
	w.publishPreview(preview)
}

func boundedUTF8(value string, maximum int) string {
	if maximum <= 0 || len(value) <= maximum {
		return value
	}
	value = value[len(value)-maximum:]
	for len(value) > 0 && !utf8.ValidString(value) {
		value = value[1:]
	}
	return value
}

func (w *Worker) finishTurn(turnError string) {
	w.mu.Lock()
	if w.closed || w.status.State != workers.WorkerStateRunning {
		w.mu.Unlock()
		return
	}
	preview := Preview{Content: w.preview, Done: true}
	w.preview = ""
	w.lastActive = time.Now()
	w.status = workers.WorkerStatus{
		State: workers.WorkerStateIdle, Error: turnError,
		Model: w.model, ModelProvider: Provider,
	}
	status := w.status
	w.mu.Unlock()
	w.publishPreview(preview)
	w.publishStatus(status)
	w.scheduleRefresh()
}

func (w *Worker) scheduleRefresh() {
	if w.refresh == nil {
		return
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	if w.refreshing {
		w.refreshAgain = true
		w.mu.Unlock()
		return
	}
	w.refreshing = true
	w.background.Add(1)
	w.mu.Unlock()
	go func() {
		defer w.background.Done()
		for {
			ctx, cancel := context.WithTimeout(w.ctx, w.refreshTimeout)
			projection, err := w.refresh(ctx, w.nativeID, w.cwd)
			cancel()
			if err != nil && w.ctx.Err() == nil {
				w.publishError(fmt.Errorf("refresh OpenCode projection: %w", err))
			} else if err == nil && w.callbacks.Projection != nil {
				w.mu.Lock()
				closed := w.closed
				w.mu.Unlock()
				if !closed {
					w.callbacks.Projection(projection)
				}
			}
			w.mu.Lock()
			if !w.refreshAgain || w.closed {
				w.refreshing = false
				w.refreshAgain = false
				w.mu.Unlock()
				return
			}
			w.refreshAgain = false
			w.mu.Unlock()
		}
	}()
}

func (w *Worker) operationError(err error) error {
	w.mu.Lock()
	if !w.closed && w.status.State != workers.WorkerStateError {
		w.status = workers.WorkerStatus{State: workers.WorkerStateIdle, Error: err.Error(), Model: w.model, ModelProvider: Provider}
		w.lastActive = time.Now()
	}
	status := w.status
	w.mu.Unlock()
	w.publishStatus(status)
	w.publishError(err)
	return err
}

func (w *Worker) abortError(err error) error {
	w.mu.Lock()
	if !w.closed && w.status.State != workers.WorkerStateError {
		// A failed or rejected native abort is not a terminal transition. Keep
		// the worker running until OpenCode's authoritative status/event stream
		// says otherwise.
		w.status.Error = err.Error()
		w.lastActive = time.Now()
	}
	status := w.status
	w.mu.Unlock()
	w.publishStatus(status)
	w.publishError(err)
	return err
}

func (w *Worker) fatal(err error) {
	w.mu.Lock()
	if w.closed || w.status.State == workers.WorkerStateError {
		w.mu.Unlock()
		return
	}
	w.status = workers.WorkerStatus{State: workers.WorkerStateError, Error: err.Error(), Model: w.model, ModelProvider: Provider}
	w.lastActive = time.Now()
	status := w.status
	w.mu.Unlock()
	w.publishStatus(status)
	w.publishError(err)
}

func (w *Worker) publishPreview(preview Preview) {
	if w.callbacks.Preview != nil {
		w.callbacks.Preview(preview)
	}
}
func (w *Worker) publishStatus(status workers.WorkerStatus) {
	if w.callbacks.Status != nil {
		w.callbacks.Status(status)
	}
}
func (w *Worker) publishError(err error) {
	if w.callbacks.Error != nil {
		w.callbacks.Error(err)
	}
}
