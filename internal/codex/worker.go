package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"pican/internal/chat"
	"pican/internal/workers"
)

type Preview struct {
	Text   string `json:"text"`
	Done   bool   `json:"done"`
	TurnID string `json:"turnId,omitempty"`
	ItemID string `json:"itemId,omitempty"`
}
type Callbacks struct {
	Preview    func(Preview)
	Status     func(workers.WorkerStatus)
	Projection func(Projection)
	Lifecycle  func(action, threadID string)
	Error      func(error)
}

// Worker owns one app-server process and implements workers.ChatWorker.
type Worker struct {
	mu                                      sync.Mutex
	turnOpMu                                sync.Mutex
	background                              sync.WaitGroup
	client                                  *Client
	command                                 []string
	sessionPath, sessionsDir, nativeID, cwd string
	model, effort, activeTurn               string
	status                                  workers.WorkerStatus
	callbacks                               Callbacks
	statusCh                                chan workers.WorkerStatus
	thread                                  Thread
	preview                                 map[string]*strings.Builder
	reviewThreads                           map[string]struct{}
	reviewStarting                          bool
	completedTurns                          map[string]struct{}
	revision                                uint64
	materializePending                      bool
	closed                                  bool
	startedAt                               time.Time
	lastActive                              time.Time
}

var _ workers.ChatWorker = (*Worker)(nil)

// NewWorker validates a Codex projection, starts app-server, initializes it,
// resumes its native thread, and refreshes the projection.
func NewWorker(ctx context.Context, sessionPath string, command []string, callbacks Callbacks) (*Worker, error) {
	meta, err := ReadProjectionMetadata(sessionPath)
	if err != nil {
		return nil, err
	}
	w := &Worker{command: append([]string(nil), command...), sessionPath: sessionPath, sessionsDir: filepath.Dir(filepath.Dir(sessionPath)), nativeID: meta.NativeID, cwd: meta.CWD, model: meta.Model, effort: meta.Effort, status: workers.WorkerStatus{State: workers.WorkerStateIdle, Model: meta.Model, ModelProvider: Provider, ThinkingLevel: meta.Effort}, callbacks: callbacks, statusCh: make(chan workers.WorkerStatus, 1), preview: map[string]*strings.Builder{}, reviewThreads: map[string]struct{}{}, completedTurns: map[string]struct{}{}, startedAt: time.Now(), lastActive: time.Now()}
	ready := make(chan struct{})
	c, err := NewClient(ctx, command, func(notification Notification) {
		<-ready
		w.mu.Lock()
		if w.closed {
			w.mu.Unlock()
			return
		}
		w.background.Add(1)
		w.mu.Unlock()
		defer w.background.Done()
		w.handleNotification(notification)
	})
	if err != nil {
		close(ready)
		return nil, err
	}
	w.client = c
	thread, err := c.ResumeThread(ctx, w.nativeID, w.cwd, w.model)
	if err != nil {
		close(ready)
		_ = c.Close()
		return nil, err
	}
	full, err := c.ReadThread(ctx, thread.ID)
	if err != nil {
		close(ready)
		_ = c.Close()
		return nil, err
	}
	if full.CWD == "" {
		full.CWD = w.cwd
	}
	if thread.Model != "" {
		w.model = thread.Model
	}
	if thread.Effort != "" {
		w.effort = thread.Effort
	}
	applyOpenMetadata(&full, thread)
	full.Model = w.model
	full.Effort = w.effort
	w.thread = full
	w.activeTurn = activeTurnID(full)
	state := workers.WorkerStateIdle
	if w.activeTurn != "" {
		state = workers.WorkerStateRunning
	}
	w.status = workers.WorkerStatus{State: state, Model: w.model, ModelProvider: Provider, ThinkingLevel: w.effort}
	projection, err := Materialize(w.sessionsDir, full)
	if err != nil {
		close(ready)
		_ = c.Close()
		return nil, err
	}
	close(ready)
	if callbacks.Projection != nil {
		callbacks.Projection(projection)
	}
	if callbacks.Status != nil {
		w.background.Add(1)
		go func() {
			defer w.background.Done()
			for status := range w.statusCh {
				callbacks.Status(status)
			}
		}()
	}
	w.background.Add(1)
	go func() {
		defer w.background.Done()
		<-c.done
		if err := c.Err(); err != nil {
			w.protocolError(err)
		}
	}()
	return w, nil
}

func (w *Worker) Prompt(ctx context.Context, request chat.Request) error {
	w.turnOpMu.Lock()
	defer w.turnOpMu.Unlock()
	inputs := make([]UserInput, 0, 1+len(request.Images))
	if request.Message != "" {
		inputs = append(inputs, TextInput(request.Message))
	}
	for _, image := range request.Images {
		data := image.Data
		if !strings.HasPrefix(data, "data:") {
			data = "data:" + image.MimeType + ";base64," + data
		}
		inputs = append(inputs, ImageInput(data))
	}
	w.mu.Lock()
	w.lastActive = time.Now()
	active := w.activeTurn
	model, effort := w.model, w.effort
	w.setStatusLocked(workers.WorkerStateRunning, "")
	w.mu.Unlock()
	if active != "" {
		turnID, err := w.client.SteerTurn(ctx, w.nativeID, active, inputs)
		if err != nil {
			return w.operationError(err, workers.WorkerStateRunning)
		}
		if turnID == "" {
			return w.operationError(errors.New("Codex returned an empty steer turn id"), workers.WorkerStateRunning)
		}
		w.mu.Lock()
		w.activeTurn = turnID
		w.mu.Unlock()
		return nil
	}

	var turn Turn
	var reviewThreadID string
	var err error
	switch {
	case len(request.Images) == 0 && strings.TrimSpace(request.Message) == "/compact":
		err = w.client.StartCompact(ctx, w.nativeID)
		if err == nil {
			return nil
		}
	case len(request.Images) == 0 && strings.TrimSpace(request.Message) == "/review":
		w.mu.Lock()
		w.reviewStarting = true
		w.mu.Unlock()
		var review ReviewStartResult
		review, err = w.client.StartReview(ctx, w.nativeID)
		w.mu.Lock()
		if review.ReviewThreadID != "" {
			w.reviewThreads[review.ReviewThreadID] = struct{}{}
		}
		w.reviewStarting = false
		w.mu.Unlock()
		turn, reviewThreadID = review.Turn, review.ReviewThreadID
	default:
		turn, err = w.client.StartTurn(ctx, w.nativeID, inputs, w.cwd, model, effort)
	}
	if err != nil {
		return w.operationError(err, workers.WorkerStateIdle)
	}
	if turn.ID == "" {
		return w.operationError(errors.New("Codex returned an empty turn id"), workers.WorkerStateIdle)
	}
	w.mu.Lock()
	if reviewThreadID != "" {
		w.reviewThreads[reviewThreadID] = struct{}{}
	}
	if _, completed := w.completedTurns[turn.ID]; !completed {
		w.activeTurn = turn.ID
		w.revision++
	}
	w.mu.Unlock()
	return nil
}
func (w *Worker) SetModel(_ context.Context, provider, modelID string) error {
	if provider != "" && provider != Provider {
		return fmt.Errorf("Codex worker requires provider %q", Provider)
	}
	w.mu.Lock()
	w.model = modelID
	w.status.Model = modelID
	w.lastActive = time.Now()
	w.revision++
	w.mu.Unlock()
	return w.appendSetting("model_change", map[string]any{"provider": Provider, "modelId": modelID})
}
func (w *Worker) SetThinkingLevel(_ context.Context, level string) error {
	w.mu.Lock()
	w.effort = level
	w.status.ThinkingLevel = level
	w.lastActive = time.Now()
	w.revision++
	w.mu.Unlock()
	return w.appendSetting("thinking_level_change", map[string]any{"thinkingLevel": level})
}
func (w *Worker) Abort(ctx context.Context) error {
	w.turnOpMu.Lock()
	defer w.turnOpMu.Unlock()
	w.mu.Lock()
	turn := w.activeTurn
	w.lastActive = time.Now()
	w.mu.Unlock()
	if turn == "" {
		return nil
	}
	if err := w.client.InterruptTurn(ctx, w.nativeID, turn); err != nil {
		return w.operationError(err, workers.WorkerStateRunning)
	}
	return nil
}
func (w *Worker) GetState(context.Context) (workers.WorkerStatus, error) { return w.Status(), nil }
func (w *Worker) GetCommands(context.Context) ([]workers.SlashCommand, error) {
	return []workers.SlashCommand{{Name: "review", Description: "Review the current changes", Source: "codex"}, {Name: "compact", Description: "Compact the current thread context", Source: "codex"}}, nil
}
func (w *Worker) Status() workers.WorkerStatus { w.mu.Lock(); defer w.mu.Unlock(); return w.status }
func (w *Worker) PID() int                     { return w.client.PID() }
func (w *Worker) StartedAt() time.Time         { return w.startedAt }
func (w *Worker) IdleSince(now time.Time) time.Duration {
	w.mu.Lock()
	defer w.mu.Unlock()
	return now.Sub(w.lastActive)
}
func (w *Worker) Close() error {
	w.mu.Lock()
	if !w.closed {
		w.closed = true
		close(w.statusCh)
	}
	w.mu.Unlock()
	err := w.client.Close()
	w.background.Wait()
	return err
}

func (w *Worker) setStatusLocked(state workers.State, message string) {
	w.status = workers.WorkerStatus{State: state, Error: message, Model: w.model, ModelProvider: Provider, ThinkingLevel: w.effort}
	if w.callbacks.Status != nil && !w.closed {
		select {
		case w.statusCh <- w.status:
		default:
			// Status is level-triggered. Replace an undelivered intermediate
			// transition with the newest authoritative state.
			select {
			case <-w.statusCh:
			default:
			}
			select {
			case w.statusCh <- w.status:
			default:
			}
		}
	}
}
func (w *Worker) operationError(err error, fallback workers.State) error {
	if clientErr := w.client.Err(); clientErr != nil {
		return w.protocolError(clientErr)
	}
	w.mu.Lock()
	state := fallback
	if w.activeTurn != "" {
		state = workers.WorkerStateRunning
	}
	w.setStatusLocked(state, "")
	w.mu.Unlock()
	if w.callbacks.Error != nil {
		w.callbacks.Error(err)
	}
	return err
}

func (w *Worker) protocolError(err error) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return err
	}
	w.setStatusLocked(workers.WorkerStateError, err.Error())
	w.mu.Unlock()
	if w.callbacks.Error != nil {
		w.callbacks.Error(err)
	}
	return err
}

func (w *Worker) acceptsThread(threadID string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if threadID == w.nativeID {
		return true
	}
	if w.reviewStarting && threadID != "" {
		w.reviewThreads[threadID] = struct{}{}
		return true
	}
	_, ok := w.reviewThreads[threadID]
	return ok
}

func (w *Worker) handleNotification(n Notification) {
	var identity struct{ ThreadID, TurnID, ItemID, Delta string }
	_ = json.Unmarshal(n.Params, &identity)
	switch n.Method {
	case "thread/started":
		var p struct {
			Thread Thread `json:"thread"`
		}
		if json.Unmarshal(n.Params, &p) == nil && p.Thread.ID != "" {
			w.refreshNotificationThread(p.Thread.ID, false)
		}
	case "turn/started":
		var p struct {
			ThreadID string `json:"threadId"`
			Turn     Turn   `json:"turn"`
		}
		if json.Unmarshal(n.Params, &p) != nil || !w.acceptsThread(p.ThreadID) {
			return
		}
		w.mu.Lock()
		delete(w.completedTurns, p.Turn.ID)
		w.activeTurn = p.Turn.ID
		w.upsertTurnLocked(p.Turn)
		w.revision++
		w.setStatusLocked(workers.WorkerStateRunning, "")
		w.mu.Unlock()
	case "item/started":
		var p struct {
			ThreadID string     `json:"threadId"`
			TurnID   string     `json:"turnId"`
			Item     ThreadItem `json:"item"`
		}
		if json.Unmarshal(n.Params, &p) == nil && w.acceptsThread(p.ThreadID) {
			// Agent text is owned by chat-preview until item/completed. Writing the
			// same partial item into the projection renders two competing streams.
			if p.Item.Type != "agentMessage" {
				w.applyLiveItem(p.TurnID, p.Item)
			}
		}
	case "item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta", "command/exec/outputDelta", "process/outputDelta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "item/mcpToolCall/progress":
		if !w.acceptsThread(identity.ThreadID) {
			return
		}
		text := identity.Delta
		if text == "" {
			var raw map[string]json.RawMessage
			_ = json.Unmarshal(n.Params, &raw)
			text = rawString(raw["output"])
			if text == "" {
				text = rawString(raw["patch"])
			}
			if text == "" {
				text = rawString(raw["message"])
			}
		}
		itemType, field := "agentMessage", "text"
		switch n.Method {
		case "item/plan/delta":
			itemType = "plan"
		case "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta":
			itemType = "reasoning"
			field = "content"
		case "item/commandExecution/outputDelta", "command/exec/outputDelta", "process/outputDelta":
			itemType = "commandExecution"
			field = "aggregatedOutput"
		case "item/fileChange/outputDelta", "item/fileChange/patchUpdated":
			itemType = "fileChange"
			field = "output"
		case "item/mcpToolCall/progress":
			itemType = "mcpToolCall"
			field = "result"
		}
		if identity.ItemID == "" {
			identity.ItemID = n.Method + "-" + identity.TurnID
		}
		if n.Method == "item/agentMessage/delta" {
			visible := w.appendPreviewDelta(identity.TurnID, identity.ItemID, text)
			if w.callbacks.Preview != nil {
				w.callbacks.Preview(Preview{Text: visible, TurnID: identity.TurnID, ItemID: identity.ItemID})
			}
			break
		}
		w.applyDelta(identity.TurnID, identity.ItemID, itemType, field, text)
	case "item/completed":
		var p struct {
			ThreadID string     `json:"threadId"`
			TurnID   string     `json:"turnId"`
			Item     ThreadItem `json:"item"`
		}
		if json.Unmarshal(n.Params, &p) == nil && w.acceptsThread(p.ThreadID) {
			w.applyCompletedItem(p.TurnID, p.Item)
		}
	case "turn/completed":
		var p struct {
			ThreadID string `json:"threadId"`
			Turn     Turn   `json:"turn"`
		}
		if json.Unmarshal(n.Params, &p) == nil && w.acceptsThread(p.ThreadID) {
			w.completeTurn(p.ThreadID, p.Turn)
		}
	case "turn/plan/updated":
		var p struct {
			ThreadID, TurnID string
			Plan             json.RawMessage `json:"plan"`
			Explanation      string          `json:"explanation"`
		}
		if json.Unmarshal(n.Params, &p) == nil && w.acceptsThread(p.ThreadID) {
			w.applySynthetic(p.TurnID, "turn-plan-"+p.TurnID, "plan", string(p.Plan)+"\n"+p.Explanation)
		}
	case "turn/diff/updated":
		var p struct{ ThreadID, TurnID, Diff string }
		if json.Unmarshal(n.Params, &p) == nil && w.acceptsThread(p.ThreadID) {
			w.mu.Lock()
			w.thread.TurnDiff = p.Diff
			w.revision++
			w.mu.Unlock()
			w.scheduleMaterialize()
		}
	case "thread/tokenUsage/updated":
		var p struct {
			ThreadID   string
			TokenUsage json.RawMessage `json:"tokenUsage"`
		}
		if json.Unmarshal(n.Params, &p) == nil && w.acceptsThread(p.ThreadID) {
			w.mu.Lock()
			w.thread.TokenUsage = append(json.RawMessage(nil), p.TokenUsage...)
			w.revision++
			w.mu.Unlock()
			w.scheduleMaterialize()
		}
	case "thread/compacted":
		if w.acceptsThread(identity.ThreadID) {
			w.applySynthetic(identity.TurnID, "compaction-"+identity.TurnID, "contextCompaction", "")
		}
	case "model/rerouted":
		var p struct{ ThreadID, TurnID, FromModel, ToModel, Reason string }
		if json.Unmarshal(n.Params, &p) == nil && w.acceptsThread(p.ThreadID) {
			w.mu.Lock()
			w.model = p.ToModel
			w.thread.Model = p.ToModel
			w.status.Model = p.ToModel
			w.revision++
			w.mu.Unlock()
			w.applyNotice(p.TurnID, "Model rerouted from "+p.FromModel+" to "+p.ToModel+": "+p.Reason)
		}
	case "model/verification":
		if w.acceptsThread(identity.ThreadID) {
			w.applyNotice(identity.TurnID, "Model verification: "+string(n.Params))
		}
	case "warning", "guardianWarning", "deprecationNotice", "configWarning", "windows/worldWritableWarning":
		var p struct{ ThreadID, Message, Summary, Details string }
		if json.Unmarshal(n.Params, &p) == nil && (p.ThreadID == "" || w.acceptsThread(p.ThreadID)) {
			msg := p.Message
			if msg == "" {
				msg = p.Summary
			}
			if p.Details != "" {
				msg += ": " + p.Details
			}
			w.applyNotice(identity.TurnID, msg)
		}
	case "thread/name/updated", "thread/unarchived":
		if identity.ThreadID != "" {
			w.refreshNotificationThread(identity.ThreadID, false)
		}
	case "thread/archived", "thread/deleted":
		affectedID := identity.ThreadID
		if projections, err := FindProjections(w.sessionsDir); err == nil {
			if path := projections[identity.ThreadID]; path != "" {
				affectedID = filepath.Base(path)
				_ = RemoveProjection(path, identity.ThreadID)
			}
		}
		if identity.ThreadID == w.nativeID {
			w.mu.Lock()
			w.activeTurn = ""
			w.setStatusLocked(workers.WorkerStateIdle, "")
			w.mu.Unlock()
		}
		if w.callbacks.Lifecycle != nil {
			w.callbacks.Lifecycle(n.Method, affectedID)
		}
	case "thread/closed":
		if identity.ThreadID == w.nativeID {
			w.mu.Lock()
			w.activeTurn = ""
			w.setStatusLocked(workers.WorkerStateIdle, "")
			w.mu.Unlock()
		}
		if identity.ThreadID != "" {
			w.refreshNotificationThread(identity.ThreadID, false)
		}
	case "thread/status/changed":
		var p struct {
			ThreadID string `json:"threadId"`
			Status   struct {
				Type string `json:"type"`
			} `json:"status"`
		}
		if json.Unmarshal(n.Params, &p) == nil && w.acceptsThread(p.ThreadID) {
			w.mu.Lock()
			switch p.Status.Type {
			case "active":
				w.setStatusLocked(workers.WorkerStateRunning, "")
			case "idle", "notLoaded":
				w.activeTurn = ""
				w.setStatusLocked(workers.WorkerStateIdle, "")
			case "systemError":
				w.activeTurn = ""
				w.setStatusLocked(workers.WorkerStateError, "Codex thread system error")
			}
			w.mu.Unlock()
		}
	case "error":
		var p struct {
			ThreadID, TurnID string
			WillRetry        bool `json:"willRetry"`
			Error            struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(n.Params, &p) != nil || (p.ThreadID != "" && !w.acceptsThread(p.ThreadID)) {
			return
		}
		if p.WillRetry {
			w.applyNotice(p.TurnID, "Codex retrying: "+p.Error.Message)
			return
		}
		w.mu.Lock()
		if w.activeTurn == p.TurnID {
			w.activeTurn = ""
		}
		w.mu.Unlock()
		w.protocolError(fmt.Errorf("codex protocol error: %s", p.Error.Message))
	}
}

func (w *Worker) upsertTurnLocked(turn Turn) {
	for i := range w.thread.Turns {
		if w.thread.Turns[i].ID == turn.ID {
			w.thread.Turns[i] = turn
			return
		}
	}
	w.thread.Turns = append(w.thread.Turns, turn)
}

func mergeItemSnapshots(preferred, fallback []ThreadItem) []ThreadItem {
	preferredByID := make(map[string]ThreadItem, len(preferred))
	for _, item := range preferred {
		preferredByID[item.ID] = item
	}
	merged := make([]ThreadItem, 0, len(preferred)+len(fallback))
	seen := make(map[string]struct{}, len(preferred)+len(fallback))
	// Live notification order is the freshest ordering boundary. Replace items
	// present in the authoritative snapshot, but retain live items that the
	// immediate post-completion read has not exposed yet.
	for _, item := range fallback {
		if replacement, ok := preferredByID[item.ID]; ok {
			item = replacement
		}
		merged = append(merged, item)
		seen[item.ID] = struct{}{}
	}
	for _, item := range preferred {
		if _, ok := seen[item.ID]; ok {
			continue
		}
		merged = append(merged, item)
	}
	return merged
}

func preserveLocalTurns(remote, local Thread, turnIDs ...string) Thread {
	protected := make(map[string]struct{}, len(turnIDs))
	for _, turnID := range turnIDs {
		if turnID != "" {
			protected[turnID] = struct{}{}
		}
	}
	localTurns := make(map[string]Turn, len(local.Turns))
	for _, turn := range local.Turns {
		localTurns[turn.ID] = turn
	}
	seen := make(map[string]struct{}, len(remote.Turns))
	for index := range remote.Turns {
		turn := &remote.Turns[index]
		seen[turn.ID] = struct{}{}
		if _, ok := protected[turn.ID]; !ok {
			continue
		}
		if localTurn, ok := localTurns[turn.ID]; ok {
			// Immediate thread/read can lag notifications and even expose temporary
			// item identities. Keep the just-completed live turn wholesale rather
			// than combining two semantic copies under different IDs.
			*turn = localTurn
		}
	}
	for turnID := range protected {
		if _, ok := seen[turnID]; ok {
			continue
		}
		if localTurn, ok := localTurns[turnID]; ok {
			remote.Turns = append(remote.Turns, localTurn)
		}
	}
	return remote
}

func (w *Worker) mergeCompletedTurnLocked(completed Turn) {
	for index := range w.thread.Turns {
		turn := &w.thread.Turns[index]
		if turn.ID != completed.ID {
			continue
		}
		turn.Items = mergeItemSnapshots(completed.Items, turn.Items)
		if completed.Status != "" {
			turn.Status = completed.Status
		}
		if completed.StartedAt != 0 {
			turn.StartedAt = completed.StartedAt
		}
		if completed.CompletedAt != 0 {
			turn.CompletedAt = completed.CompletedAt
		}
		return
	}
	w.thread.Turns = append(w.thread.Turns, completed)
}

func (w *Worker) upsertItemLocked(turnID string, item ThreadItem) {
	for ti := range w.thread.Turns {
		if w.thread.Turns[ti].ID != turnID {
			continue
		}
		for ii := range w.thread.Turns[ti].Items {
			if w.thread.Turns[ti].Items[ii].ID == item.ID {
				w.thread.Turns[ti].Items[ii] = item
				return
			}
		}
		w.thread.Turns[ti].Items = append(w.thread.Turns[ti].Items, item)
		return
	}
	w.thread.Turns = append(w.thread.Turns, Turn{ID: turnID, Status: "inProgress", Items: []ThreadItem{item}})
}

func (w *Worker) applyLiveItem(turnID string, item ThreadItem) {
	w.mu.Lock()
	w.upsertItemLocked(turnID, item)
	w.revision++
	w.mu.Unlock()
	w.scheduleMaterialize()
}
func (w *Worker) applySynthetic(turnID, id, itemType, text string) {
	if turnID == "" {
		w.mu.Lock()
		turnID = w.activeTurn
		w.mu.Unlock()
		if turnID == "" {
			turnID = "codex-notices"
		}
	}
	raw := map[string]json.RawMessage{}
	if itemType == "agentMessage" || itemType == "plan" {
		raw["text"], _ = json.Marshal(text)
	}
	w.applyLiveItem(turnID, ThreadItem{ID: id, Type: itemType, Raw: raw})
}
func (w *Worker) applyNotice(turnID, text string) {
	if strings.TrimSpace(text) == "" {
		return
	}
	w.applySynthetic(turnID, "notice-"+stableHash(turnID, text), "agentMessage", "[Codex] "+text)
}

func (w *Worker) appendPreviewDelta(turnID, itemID, delta string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	key := turnID + "\x00" + itemID
	b := w.preview[key]
	if b == nil {
		b = &strings.Builder{}
		w.preview[key] = b
	}
	b.WriteString(delta)
	return b.String()
}

func (w *Worker) applyDelta(turnID, itemID, itemType, field, delta string) {
	w.mu.Lock()
	var item *ThreadItem
	for ti := range w.thread.Turns {
		if w.thread.Turns[ti].ID != turnID {
			continue
		}
		for ii := range w.thread.Turns[ti].Items {
			if w.thread.Turns[ti].Items[ii].ID == itemID {
				item = &w.thread.Turns[ti].Items[ii]
				break
			}
		}
	}
	if item == nil {
		placeholder := ThreadItem{ID: itemID, Type: itemType, Raw: map[string]json.RawMessage{}}
		w.upsertItemLocked(turnID, placeholder)
		for ti := range w.thread.Turns {
			if w.thread.Turns[ti].ID == turnID {
				for ii := range w.thread.Turns[ti].Items {
					if w.thread.Turns[ti].Items[ii].ID == itemID {
						item = &w.thread.Turns[ti].Items[ii]
					}
				}
			}
		}
	}
	current := rawString(item.Raw[field])
	item.Raw[field], _ = json.Marshal(current + delta)
	if itemType == "reasoning" {
		item.Raw[field], _ = json.Marshal([]string{current + delta})
	}
	if itemType == "commandExecution" {
		item.Raw["status"] = json.RawMessage(`"inProgress"`)
	}
	w.revision++
	w.mu.Unlock()
	w.scheduleMaterialize()
}

func (w *Worker) scheduleMaterialize() {
	w.mu.Lock()
	if w.closed || w.materializePending {
		w.mu.Unlock()
		return
	}
	w.materializePending = true
	w.background.Add(1)
	w.mu.Unlock()
	go func() {
		defer w.background.Done()
		timer := time.NewTimer(100 * time.Millisecond)
		defer timer.Stop()
		<-timer.C
		w.mu.Lock()
		if w.closed {
			w.materializePending = false
			w.mu.Unlock()
			return
		}
		thread := cloneThread(w.thread)
		revision := w.revision
		w.materializePending = false
		w.mu.Unlock()
		w.materializeRevision(thread, revision)
	}()
}

func (w *Worker) refreshNotificationThread(threadID string, reconcile bool) {
	if threadID == "" {
		return
	}
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.background.Add(1)
	w.mu.Unlock()
	go func() {
		defer w.background.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		thread, err := w.client.ReadThread(ctx, threadID)
		if err != nil {
			if reconcile {
				w.applyNotice("", "Reconciliation failed: "+err.Error())
			}
			return
		}
		if threadID == w.nativeID {
			w.mu.Lock()
			thread.Model = w.model
			thread.Effort = w.effort
			w.thread = thread
			w.revision++
			revision := w.revision
			w.mu.Unlock()
			w.materializeRevision(thread, revision)
			return
		}
		projection, err := Materialize(w.sessionsDir, thread)
		if err == nil {
			if w.callbacks.Projection != nil {
				w.callbacks.Projection(projection)
			}
			if w.callbacks.Lifecycle != nil {
				w.callbacks.Lifecycle("thread/materialized", projection.ID)
			}
		}
	}()
}

func (w *Worker) applyCompletedItem(turnID string, item ThreadItem) {
	w.mu.Lock()
	found := false
	for ti := range w.thread.Turns {
		if w.thread.Turns[ti].ID != turnID {
			continue
		}
		for ii := range w.thread.Turns[ti].Items {
			if w.thread.Turns[ti].Items[ii].ID == item.ID {
				w.thread.Turns[ti].Items[ii] = item
				found = true
				break
			}
		}
		if !found {
			w.thread.Turns[ti].Items = append(w.thread.Turns[ti].Items, item)
		}
		found = true
		break
	}
	if !found {
		w.thread.Turns = append(w.thread.Turns, Turn{ID: turnID, Items: []ThreadItem{item}})
	}
	w.revision++
	revision := w.revision
	thread := cloneThread(w.thread)
	var finalPreview *Preview
	for key, b := range w.preview {
		if key == turnID+"\x00"+item.ID {
			text := b.String()
			if completedText := rawString(item.Raw["text"]); completedText != "" {
				text = completedText
			}
			preview := Preview{Text: text, Done: true, TurnID: turnID, ItemID: item.ID}
			finalPreview = &preview
			delete(w.preview, key)
		}
	}
	w.mu.Unlock()
	// Commit the authoritative item before announcing preview completion. The
	// browser's done handler immediately reloads, so the canonical entry must
	// already exist for an atomic preview-to-transcript handoff.
	w.materializeRevision(thread, revision)
	if finalPreview != nil && w.callbacks.Preview != nil {
		w.callbacks.Preview(*finalPreview)
	}
}
func (w *Worker) completeTurn(threadID string, turn Turn) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.completedTurns[turn.ID] = struct{}{}
	w.mergeCompletedTurnLocked(turn)
	localSnapshot := cloneThread(w.thread)
	w.revision++
	revision := w.revision
	if w.activeTurn == turn.ID {
		w.activeTurn = ""
		w.setStatusLocked(workers.WorkerStateIdle, "")
		w.lastActive = time.Now()
	}
	newerActiveTurn := w.activeTurn
	w.background.Add(1)
	w.mu.Unlock()
	go func() {
		defer w.background.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		thread, err := w.client.ReadThread(ctx, threadID)
		if err != nil {
			w.protocolError(err)
			return
		}
		w.mu.Lock()
		if w.closed || w.revision != revision {
			w.mu.Unlock()
			return
		}
		thread.Model = w.model
		thread.Effort = w.effort
		if threadID == w.nativeID {
			thread = preserveLocalTurns(thread, localSnapshot, turn.ID, newerActiveTurn)
			w.thread = thread
		} else {
			for _, reviewTurn := range thread.Turns {
				w.upsertTurnLocked(reviewTurn)
			}
			thread = cloneThread(w.thread)
		}
		w.revision++
		materializeRevision := w.revision
		w.mu.Unlock()
		w.materializeRevision(thread, materializeRevision)
	}()
}

// materializeRevision prevents an older snapshot from replacing a projection
// after a newer notification has already advanced the worker state.
func (w *Worker) materializeRevision(thread Thread, revision uint64) {
	w.mu.Lock()
	if w.closed || w.revision != revision {
		w.mu.Unlock()
		return
	}
	projection, err := Materialize(w.sessionsDir, thread)
	w.mu.Unlock()
	if err != nil {
		w.protocolError(err)
	} else if w.callbacks.Projection != nil {
		w.callbacks.Projection(projection)
	}
}

func activeTurnID(thread Thread) string {
	for i := len(thread.Turns) - 1; i >= 0; i-- {
		if thread.Turns[i].Status == "inProgress" {
			return thread.Turns[i].ID
		}
	}
	return ""
}

func cloneThread(thread Thread) Thread {
	out := thread
	out.Status = append(json.RawMessage(nil), thread.Status...)
	out.Source = append(json.RawMessage(nil), thread.Source...)
	out.ApprovalPolicy = append(json.RawMessage(nil), thread.ApprovalPolicy...)
	out.Sandbox = append(json.RawMessage(nil), thread.Sandbox...)
	out.TokenUsage = append(json.RawMessage(nil), thread.TokenUsage...)
	out.Turns = make([]Turn, len(thread.Turns))
	for turnIndex, turn := range thread.Turns {
		out.Turns[turnIndex] = turn
		out.Turns[turnIndex].Items = make([]ThreadItem, len(turn.Items))
		for itemIndex, item := range turn.Items {
			out.Turns[turnIndex].Items[itemIndex] = item
			out.Turns[turnIndex].Items[itemIndex].Raw = cloneRawMap(item.Raw)
		}
	}
	return out
}

func (w *Worker) appendSetting(kind string, fields map[string]any) error {
	store, err := projectionStoreForPath(w.sessionPath)
	if err != nil {
		return err
	}
	entry := map[string]any{"type": kind, "id": "codex-local-" + stableHash(kind, time.Now().UTC().Format(time.RFC3339Nano)), "timestamp": time.Now().UTC().Format(time.RFC3339Nano)}
	for k, v := range fields {
		entry[k] = v
	}
	return store.AppendLocal(w.sessionPath, entry)
}
