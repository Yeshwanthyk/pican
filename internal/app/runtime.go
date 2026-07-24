package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"pican/internal/claude"
	"pican/internal/codex"
	"pican/internal/rpc"
	"pican/internal/runtimes"
	"pican/internal/server"
	"pican/internal/sessions"
	"pican/internal/workers"
)

type runtimeModelLoader func(context.Context) ([]json.RawMessage, error)

type applicationRuntime struct {
	registration runtimes.Registration
	models       runtimeModelLoader
}

type runtimeRegistry struct {
	registry *runtimes.Registry
	models   map[runtimes.ID]runtimeModelLoader
}

func newRuntimeRegistry(registered ...applicationRuntime) (*runtimeRegistry, error) {
	registrations := make([]runtimes.Registration, 0, len(registered))
	models := make(map[runtimes.ID]runtimeModelLoader, len(registered))
	for _, runtime := range registered {
		registrations = append(registrations, runtime.registration)
		if runtime.models != nil {
			models[runtime.registration.Descriptor.ID] = runtime.models
		} else if runtime.registration.Descriptor.Capabilities.ModelListing {
			return nil, fmt.Errorf("runtime %q: model listing capability requires a model loader", runtime.registration.Descriptor.ID)
		}
	}
	registry, err := runtimes.New(registrations...)
	if err != nil {
		return nil, err
	}
	return &runtimeRegistry{registry: registry, models: models}, nil
}

type runtimeSet struct {
	registry *runtimeRegistry
	ordered  []runtimes.ID
	enabled  map[runtimes.ID]struct{}
}

func runtimeSelectionIncludes(value string, target runtimes.ID) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "both" {
		normalized = "pi,codex"
	}
	for _, part := range strings.Split(normalized, ",") {
		if strings.TrimSpace(part) == string(target) {
			return true
		}
	}
	return false
}

func parseRuntime(value string, registry *runtimeRegistry) (runtimeSet, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "both" {
		normalized = "pi,codex"
	}
	if normalized == "" {
		return runtimeSet{}, fmt.Errorf("invalid runtime %q: runtime is required", value)
	}

	selected := make(map[runtimes.ID]struct{})
	for _, part := range strings.Split(normalized, ",") {
		name := strings.TrimSpace(part)
		if name == "" {
			return runtimeSet{}, fmt.Errorf("invalid runtime %q: empty runtime ID", value)
		}
		registration, err := registry.registry.Open(name)
		if err != nil {
			return runtimeSet{}, fmt.Errorf("invalid runtime %q: %w", value, err)
		}
		selected[registration.Descriptor.ID] = struct{}{}
	}

	ordered := make([]runtimes.ID, 0, len(selected))
	for _, id := range registry.registry.IDs() {
		if _, ok := selected[id]; ok {
			ordered = append(ordered, id)
		}
	}
	return runtimeSet{registry: registry, ordered: ordered, enabled: selected}, nil
}

func (s runtimeSet) enables(runtime string) bool {
	_, ok := s.enabled[runtimes.ID(runtime)]
	return ok
}

func (s runtimeSet) only(runtime runtimes.ID) bool {
	return len(s.ordered) == 1 && s.ordered[0] == runtime
}

func (s runtimeSet) labelsExcept(excluded runtimes.ID) string {
	labels := make([]string, 0, len(s.ordered)-1)
	for _, id := range s.ordered {
		if id == excluded {
			continue
		}
		registration, ok := s.registry.registry.Lookup(id)
		if ok {
			labels = append(labels, registration.Descriptor.Label)
		}
	}
	return strings.Join(labels, ", ")
}

func (s runtimeSet) enabledRuntimes() []string {
	enabled := make([]string, len(s.ordered))
	for i, id := range s.ordered {
		enabled[i] = string(id)
	}
	return enabled
}

func (s runtimeSet) selectedRegistry() (*runtimes.Registry, error) {
	registrations := make([]runtimes.Registration, 0, len(s.ordered))
	for _, id := range s.ordered {
		registration, ok := s.registry.registry.Lookup(id)
		if !ok {
			return nil, fmt.Errorf("runtime %q is no longer registered", id)
		}
		registrations = append(registrations, registration)
	}
	return runtimes.New(registrations...)
}

func (s runtimeSet) defaultRuntime() string {
	if len(s.ordered) == 0 {
		return "pi"
	}
	return string(s.ordered[0])
}

func (s runtimeSet) requiresExistingSessionsDir() bool {
	for _, id := range s.ordered {
		registration, ok := s.registry.registry.Lookup(id)
		if ok && registration.Descriptor.ProjectionMode == runtimes.ProjectionAppendOnlyNative {
			return true
		}
	}
	return false
}

func codexCommand(executable string) []string {
	return []string{executable, "app-server", "--stdio"}
}

func piWorkerFactory(currentServer func() *server.Server) workers.Factory {
	return func(sessionID, sessionPath string) (workers.ChatWorker, error) {
		return rpc.NewPiWorkerWithStatusEvents(
			sessionPath,
			func(preview rpc.StreamPreview) {
				if srv := currentServer(); srv != nil {
					srv.BroadcastChatPreview(sessionID, preview)
				}
			},
			func(event string, payload json.RawMessage) {
				if srv := currentServer(); srv != nil {
					srv.BroadcastExtensionUI(sessionID, event, payload)
				}
			},
			func(status workers.WorkerStatus) {
				if srv := currentServer(); srv != nil {
					srv.BroadcastWorkerStatus(sessionID, status)
				}
			},
		)
	}
}

func claudeWorkerFactory(command, home string, catalog *claude.Catalog, currentServer func() *server.Server) workers.Factory {
	return func(sessionID, sessionPath string) (workers.ChatWorker, error) {
		return claude.NewWorker(sessionPath, command, home, catalog, claude.Callbacks{
			Preview: func(preview claude.Preview) {
				if srv := currentServer(); srv != nil {
					srv.BroadcastChatPreview(sessionID, rpc.StreamPreview{
						Content: preview.Content, Done: preview.Done,
						TurnID: preview.TurnID, ItemID: preview.ItemID,
					})
				}
			},
			Status: func(status workers.WorkerStatus) {
				if srv := currentServer(); srv != nil {
					srv.BroadcastWorkerStatus(sessionID, status)
				}
			},
			Projection: func(projection claude.Projection) {
				if srv := currentServer(); srv != nil {
					target := projection.ID
					if target == "" {
						target = sessionID
					}
					srv.NotifyWorkerUpdate(target, true)
				}
			},
			Error: func(err error) {
				fmt.Fprintf(os.Stderr, "Claude worker failed for %s: %v\n", sessionID, err)
			},
			Unknown: func(recordType string) {
				fmt.Fprintf(os.Stderr, "Claude worker ignored stream-json record %q for %s\n", recordType, sessionID)
			},
		})
	}
}

func codexWorkerFactory(sessionsDir string, command []string, currentServer func() *server.Server) workers.Factory {
	return func(sessionID, sessionPath string) (workers.ChatWorker, error) {
		parsed, err := sessions.ParseFile(sessionPath, filepath.Base(filepath.Dir(sessionPath)), filepath.Base(sessionPath))
		if err != nil {
			return nil, fmt.Errorf("read session runtime: %w", err)
		}
		if _, err := codex.ReadProjectionMetadata(sessionPath); err != nil {
			return nil, err
		}
		workerCtx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
		defer cancel()
		return codex.NewWorker(workerCtx, sessionPath, command, codex.Callbacks{
			Preview: func(preview codex.Preview) {
				if srv := currentServer(); srv != nil {
					srv.BroadcastChatPreview(sessionID, rpc.StreamPreview{Content: preview.Text, Done: preview.Done, TurnID: preview.TurnID, ItemID: preview.ItemID})
				}
			},
			Status: func(workers.WorkerStatus) {
				if srv := currentServer(); srv != nil {
					srv.NotifyWorkerUpdate(sessionID, false)
				}
			},
			Projection: func(projection codex.Projection) {
				if srv := currentServer(); srv != nil {
					target := projection.ID
					if target == "" {
						target = sessionID
					}
					srv.NotifyWorkerUpdate(target, true)
				}
			},
			Lifecycle: func(action string, affectedID string) {
				if srv := currentServer(); srv != nil {
					target := affectedID
					if target == "" || target == parsed.NativeID {
						target = sessionID
					}
					srv.NotifyCodexLifecycle(action, target)
				}
			},
			Error: func(err error) {
				fmt.Fprintf(os.Stderr, "Codex worker failed for %s: %v\n", sessionID, err)
				if srv := currentServer(); srv != nil {
					srv.NotifyWorkerUpdate(sessionID, true)
				}
			},
		})
	}
}

type claudeService struct {
	sessionsDir string
}

func (c claudeService) StartSession(cwd, model string) (claude.Projection, error) {
	return claude.CreateSessionProjection(c.sessionsDir, cwd, model)
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
	label      string
	syncing    bool
	available  bool
	reason     string
	syncFn     func(context.Context) (runtimes.CatalogResult, error)
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

func newCatalogSyncer(label string, syncFn func(context.Context) (runtimes.CatalogResult, error), timeout, interval time.Duration) *catalogSyncer {
	return &catalogSyncer{label: label, syncFn: syncFn, timeout: timeout, interval: interval, stop: make(chan struct{}), done: make(chan struct{})}
}

func (s *catalogSyncer) Sync(ctx context.Context) (runtimes.CatalogResult, error) {
	syncCtx, cancel := context.WithTimeout(ctx, s.timeout)
	s.mu.Lock()
	if s.syncing {
		s.mu.Unlock()
		cancel()
		return runtimes.CatalogResult{}, nil
	}
	s.syncing = true
	s.syncCancel = cancel
	s.mu.Unlock()

	result, err := s.syncFn(syncCtx)
	cancel()
	if err != nil {
		// A failed scan can never authorize projection pruning, even if a
		// buggy adapter returned contradictory completeness metadata.
		result.Complete = false
	}

	s.mu.Lock()
	s.syncing = false
	s.syncCancel = nil
	s.available = err == nil
	if err != nil {
		s.reason = s.label + " runtime is unavailable: " + err.Error()
	} else {
		s.reason = ""
	}
	s.mu.Unlock()
	return result, err
}

func (s *catalogSyncer) status() (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.available, s.reason
}

func (s *catalogSyncer) availability(context.Context) runtimes.Availability {
	available, reason := s.status()
	return runtimes.Availability{Available: available, Reason: reason}
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
					_, _ = s.Sync(runCtx)
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

func runtimeModels(ctx context.Context, enabled runtimeSet, sessionsDir string, query server.ModelQuery) (json.RawMessage, error) {
	runtime := query.Runtime
	if runtime == "" && query.SessionID != "" {
		if resolved, err := sessions.ResolveByID(sessionsDir, query.SessionID); err == nil {
			runtime = resolved.Session.Runtime
		}
	}
	if runtime != "" && !enabled.enables(runtime) {
		return nil, fmt.Errorf("runtime %q is not enabled", runtime)
	}
	if runtime != "" {
		registration, ok := enabled.registry.registry.Lookup(runtimes.ID(runtime))
		if !ok || !registration.Descriptor.Capabilities.ModelListing {
			return nil, fmt.Errorf("runtime %q does not support model discovery", runtime)
		}
	}

	ids := enabled.ordered
	if runtime != "" {
		ids = []runtimes.ID{runtimes.ID(runtime)}
	}
	var models []json.RawMessage
	discoveredAnyRuntime := false
	for _, id := range ids {
		registration, ok := enabled.registry.registry.Lookup(id)
		if !ok || !registration.Descriptor.Capabilities.ModelListing {
			continue
		}
		loader := enabled.registry.models[id]
		if loader == nil {
			return nil, fmt.Errorf("runtime %q does not support model discovery", id)
		}
		discovered, err := loader(ctx)
		if err != nil {
			if runtime != "" || !discoveredAnyRuntime {
				return nil, err
			}
			continue
		}
		discoveredAnyRuntime = true
		models = append(models, discovered...)
	}
	return json.Marshal(map[string]any{"models": models})
}

func piModels(ctx context.Context) ([]json.RawMessage, error) {
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
	return payload.Models, nil
}

func codexModels(command []string) runtimeModelLoader {
	return func(ctx context.Context) ([]json.RawMessage, error) {
		discovered, err := codex.FetchModels(ctx, command)
		if err != nil {
			return nil, err
		}
		models := make([]json.RawMessage, 0, len(discovered))
		for _, model := range discovered {
			data, err := json.Marshal(model)
			if err != nil {
				return nil, err
			}
			models = append(models, data)
		}
		return models, nil
	}
}

func claudeModels(context.Context) ([]json.RawMessage, error) {
	discovered := claude.Models()
	models := make([]json.RawMessage, 0, len(discovered))
	for _, model := range discovered {
		data, err := json.Marshal(model)
		if err != nil {
			return nil, err
		}
		models = append(models, data)
	}
	return models, nil
}

func codexCatalog(sessionsDir string, command []string) func(context.Context) (runtimes.CatalogResult, error) {
	return func(ctx context.Context) (runtimes.CatalogResult, error) {
		result, err := codex.Sync(ctx, sessionsDir, command)
		return runtimes.CatalogResult{SessionIDs: result.IDs, Complete: err == nil}, err
	}
}

func codexExecutable(flagValue string) string {
	if flagValue != "" {
		return flagValue
	}
	if value := os.Getenv("PICAN_CODEX_COMMAND"); value != "" {
		return value
	}
	return "codex"
}
