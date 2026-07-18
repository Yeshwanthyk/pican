package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"pi-web/internal/codex"
	"pi-web/internal/server"
	"pi-web/internal/sessions"
)

type runtimeMode string

const (
	runtimePi    runtimeMode = "pi"
	runtimeCodex runtimeMode = "codex"
	runtimeBoth  runtimeMode = "both"
)

func parseRuntime(value string) (runtimeMode, error) {
	switch runtimeMode(strings.ToLower(strings.TrimSpace(value))) {
	case runtimePi:
		return runtimePi, nil
	case runtimeCodex:
		return runtimeCodex, nil
	case runtimeBoth:
		return runtimeBoth, nil
	default:
		return "", fmt.Errorf("invalid runtime %q: must be pi, codex, or both", value)
	}
}

func (m runtimeMode) enables(runtime string) bool {
	return string(m) == runtime || m == runtimeBoth
}

func (m runtimeMode) enabledRuntimes() []string {
	if m == runtimeBoth {
		return []string{"pi", "codex"}
	}
	return []string{string(m)}
}

func codexCommand(executable string) []string {
	return []string{executable, "app-server", "--stdio"}
}

type codexService struct {
	sessionsDir string
	command     []string
}

func (c codexService) StartSession(ctx context.Context, cwd, model, effort string) (codex.Projection, error) {
	return codex.StartSession(ctx, c.sessionsDir, c.command, cwd, model, effort)
}
func (c codexService) RenameSession(ctx context.Context, nativeID, name string) (codex.Projection, error) {
	return codex.RenameSession(ctx, c.sessionsDir, c.command, nativeID, name)
}
func (c codexService) ForkSession(ctx context.Context, nativeID string, turnID *string) (codex.Projection, error) {
	return codex.ForkSession(ctx, c.sessionsDir, c.command, nativeID, turnID)
}
func (c codexService) RefreshThread(ctx context.Context, nativeID string) (codex.Projection, error) {
	return codex.RefreshThread(ctx, c.sessionsDir, c.command, nativeID)
}
func (c codexService) ArchiveSession(ctx context.Context, nativeID string) error {
	return codex.ArchiveSession(ctx, c.sessionsDir, c.command, nativeID)
}
func (c codexService) UnarchiveSession(ctx context.Context, nativeID string) (codex.Projection, error) {
	return codex.UnarchiveSession(ctx, c.sessionsDir, c.command, nativeID)
}
func (c codexService) DeleteSession(ctx context.Context, nativeID string) error {
	return codex.DeleteSession(ctx, c.sessionsDir, c.command, nativeID)
}
func (c codexService) ResolveTurnID(path, entryID string) (string, error) {
	return codex.ResolveTurnID(path, entryID)
}
func (c codexService) LabelSessionEntry(path, entryID, label string, now func() time.Time) error {
	return codex.LabelSessionEntry(path, entryID, label, now)
}
func (c codexService) AutoTitleSession(path, name string, now func() time.Time) error {
	return codex.AutoTitleSession(path, name, now)
}

type catalogSyncer struct {
	mu         sync.Mutex
	syncing    bool
	available  bool
	reason     string
	syncFn     func(context.Context) error
	timeout    time.Duration
	interval   time.Duration
	stop       chan struct{}
	done       chan struct{}
	stopOnce   sync.Once
	startOnce  sync.Once
	started    bool
	syncCancel context.CancelFunc
	runCancel  context.CancelFunc
}

func newCatalogSyncer(syncFn func(context.Context) error, timeout, interval time.Duration) *catalogSyncer {
	return &catalogSyncer{syncFn: syncFn, timeout: timeout, interval: interval, stop: make(chan struct{}), done: make(chan struct{})}
}

func (s *catalogSyncer) sync(ctx context.Context) error {
	syncCtx, cancel := context.WithTimeout(ctx, s.timeout)
	s.mu.Lock()
	if s.syncing {
		s.mu.Unlock()
		cancel()
		return nil
	}
	s.syncing = true
	s.syncCancel = cancel
	s.mu.Unlock()

	err := s.syncFn(syncCtx)
	cancel()

	s.mu.Lock()
	s.syncing = false
	s.syncCancel = nil
	s.available = err == nil
	if err != nil {
		s.reason = "Codex runtime is unavailable: " + err.Error()
	} else {
		s.reason = ""
	}
	s.mu.Unlock()
	return err
}

func (s *catalogSyncer) status() (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.available, s.reason
}

func (s *catalogSyncer) start() {
	s.startOnce.Do(func() {
		runCtx, runCancel := context.WithCancel(context.Background())
		s.mu.Lock()
		s.started = true
		s.runCancel = runCancel
		s.mu.Unlock()
		go func() {
			defer close(s.done)
			ticker := time.NewTicker(s.interval)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					_ = s.sync(runCtx)
				case <-s.stop:
					return
				}
			}
		}()
	})
}

func (s *catalogSyncer) close() {
	s.stopOnce.Do(func() { close(s.stop) })
	s.mu.Lock()
	started := s.started
	cancel := s.syncCancel
	runCancel := s.runCancel
	s.mu.Unlock()
	if runCancel != nil {
		runCancel()
	}
	if cancel != nil {
		cancel()
	}
	if started {
		<-s.done
	}
}

func runtimeModels(ctx context.Context, mode runtimeMode, command []string, sessionsDir string, query server.ModelQuery) (json.RawMessage, error) {
	runtime := query.Runtime
	if runtime == "" && query.SessionID != "" {
		if resolved, err := sessions.ResolveByID(sessionsDir, query.SessionID); err == nil {
			runtime = resolved.Session.Runtime
		}
	}
	if runtime != "" && !mode.enables(runtime) {
		return nil, fmt.Errorf("runtime %q is not enabled", runtime)
	}
	wantPi := mode.enables("pi") && (runtime == "" || runtime == "pi")
	wantCodex := mode.enables("codex") && (runtime == "" || runtime == "codex")

	var models []json.RawMessage
	if wantPi {
		data, err := defaultModelsCache.get(ctx)
		if err != nil {
			return nil, err
		}
		var payload struct {
			Models []json.RawMessage `json:"models"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, err
		}
		models = append(models, payload.Models...)
	}
	if wantCodex {
		codexModels, err := codex.FetchModels(ctx, command)
		if err != nil {
			if runtime == "" && wantPi {
				// Both mode degrades to the preserved Pi payload.
			} else {
				return nil, err
			}
		} else {
			for _, model := range codexModels {
				data, marshalErr := json.Marshal(model)
				if marshalErr != nil {
					return nil, marshalErr
				}
				models = append(models, data)
			}
		}
	}
	return json.Marshal(map[string]any{"models": models})
}

func codexExecutable(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if value := os.Getenv("PI_WEB_CODEX_COMMAND"); value != "" {
		return value
	}
	return "codex"
}
