package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"pican/internal/runtimes"
	"pican/internal/sessions"
	"pican/internal/workers"
)

var safeShellArg = regexp.MustCompile(`^[A-Za-z0-9_@%+=:,./-]+$`)

type runtimeOperationFailure struct {
	status  int
	message string
}

func (e *runtimeOperationFailure) Error() string { return e.message }

type compatibilityCatalog struct{}

func (compatibilityCatalog) Sync(context.Context) (runtimes.CatalogResult, error) {
	// Catalog synchronization remains startup-owned. Incomplete prevents this
	// compatibility adapter from ever authorizing projection pruning.
	return runtimes.CatalogResult{Complete: false}, nil
}

func compatibilityWorkerFactory(string, string) (workers.ChatWorker, error) {
	return nil, errors.New("runtime workers are owned by the configured chat sender")
}

// serverRuntimeRegistry keeps the existing Deps surface source-compatible
// while making the registry the server's only runtime source of truth.
func serverRuntimeRegistry(deps Deps) (*runtimes.Registry, error) {
	if deps.RuntimeRegistry != nil {
		return deps.RuntimeRegistry, nil
	}
	enabled := deps.EnabledRuntimes
	if len(enabled) == 0 {
		enabled = []string{string(runtimes.PiID)}
	}
	registrations := make([]runtimes.Registration, 0, len(enabled))
	seen := make(map[string]struct{}, len(enabled))
	for _, value := range enabled {
		id := value
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		probe := func(context.Context) runtimes.Availability {
			if deps.RuntimeAvailable == nil {
				return runtimes.Availability{Available: true}
			}
			available, reason := deps.RuntimeAvailable(id)
			return runtimes.Availability{Available: available, Reason: reason}
		}
		options := runtimes.BuiltinOptions{
			Command:           id,
			AvailabilityProbe: probe,
			WorkerFactory:     compatibilityWorkerFactory,
		}
		switch id {
		case string(runtimes.PiID):
			registrations = append(registrations, runtimes.Pi(options))
		case string(runtimes.CodexID):
			options.Catalog = compatibilityCatalog{}
			registrations = append(registrations, runtimes.Codex(options))
		case string(runtimes.ClaudeID):
			options.Catalog = compatibilityCatalog{}
			registrations = append(registrations, runtimes.Claude(options))
		case string(runtimes.OpenCodeID):
			options.Catalog = compatibilityCatalog{}
			registrations = append(registrations, runtimes.OpenCode(options))
		default:
			return nil, fmt.Errorf("runtime %q is not supported by the compatibility wiring", id)
		}
	}
	return runtimes.New(registrations...)
}

func defaultRuntimeID(registry *runtimes.Registry, preferPi bool) string {
	if preferPi {
		if _, ok := registry.Lookup(runtimes.PiID); ok {
			return string(runtimes.PiID)
		}
	}
	ids := registry.IDs()
	if len(ids) == 0 {
		return ""
	}
	return string(ids[0])
}

func (s *Server) runtimeEnabled(runtime string) bool {
	if s.runtimeRegistry == nil {
		return runtime == string(runtimes.PiID)
	}
	_, err := s.runtimeRegistry.Open(runtime)
	return err == nil
}

func (s *Server) runtimeStatus(runtime string) (bool, string) {
	if s.runtimeRegistry == nil {
		if runtime == string(runtimes.PiID) {
			return true, ""
		}
		return false, runtime + " runtime is not enabled"
	}
	status, err := s.runtimeRegistry.Availability(context.Background(), runtime)
	if err != nil {
		return false, runtime + " runtime is not enabled"
	}
	return status.Available, status.Reason
}

func (s *Server) runtimeCapabilityError(ctx context.Context, runtime string, capability runtimes.Capability) error {
	descriptor, ok := s.runtimeDescriptor(runtime)
	if !ok || !descriptor.Capabilities.Supports(capability) {
		label := runtime
		if ok {
			label = descriptor.Label
		}
		return &runtimeOperationFailure{
			status:  http.StatusConflict,
			message: fmt.Sprintf("%s runtime does not support %s", label, capability),
		}
	}
	if s.runtimeRegistry == nil {
		if runtime == string(runtimes.PiID) {
			return nil
		}
		return &runtimeOperationFailure{status: http.StatusServiceUnavailable, message: descriptor.Label + " runtime is unavailable"}
	}
	availability, err := s.runtimeRegistry.Availability(ctx, runtime)
	if err != nil {
		return &runtimeOperationFailure{status: http.StatusServiceUnavailable, message: descriptor.Label + " runtime is unavailable"}
	}
	if !availability.Available {
		reason := strings.TrimSpace(availability.Reason)
		if reason == "" {
			reason = descriptor.Label + " runtime is unavailable"
		}
		return &runtimeOperationFailure{status: http.StatusServiceUnavailable, message: reason}
	}
	return nil
}

func (s *Server) requireRuntimeCapability(w http.ResponseWriter, r *http.Request, runtime string, capability runtimes.Capability) bool {
	if err := s.runtimeCapabilityError(r.Context(), runtime, capability); err != nil {
		writeRuntimeOperationError(w, err)
		return false
	}
	return true
}

func writeRuntimeOperationError(w http.ResponseWriter, err error) {
	failure := new(runtimeOperationFailure)
	if errors.As(err, &failure) {
		writeJSONError(w, failure.status, failure.message)
		return
	}
	writeJSONError(w, http.StatusConflict, err.Error())
}

func (s *Server) requireThinkingCapability(w http.ResponseWriter, r *http.Request, runtime string) bool {
	if err := s.runtimeThinkingCapabilityError(r.Context(), runtime); err != nil {
		writeRuntimeOperationError(w, err)
		return false
	}
	return true
}

func (s *Server) runtimeThinkingCapabilityError(ctx context.Context, runtime string) error {
	descriptor, ok := s.runtimeDescriptor(runtime)
	if ok && descriptor.Capabilities.EffortSelection {
		return s.runtimeCapabilityError(ctx, runtime, runtimes.CapabilityEffortSelection)
	}
	if ok && descriptor.Capabilities.ReasoningSelection {
		return s.runtimeCapabilityError(ctx, runtime, runtimes.CapabilityReasoningSelection)
	}
	label := runtime
	if ok {
		label = descriptor.Label
	}
	return &runtimeOperationFailure{status: http.StatusConflict, message: label + " runtime does not support effort or reasoning selection"}
}

func builtinRuntimeDescriptor(runtime string) (runtimes.Descriptor, bool) {
	options := runtimes.BuiltinOptions{Command: runtime}
	switch runtime {
	case string(runtimes.PiID):
		return runtimes.Pi(options).Descriptor, true
	case string(runtimes.CodexID):
		return runtimes.Codex(options).Descriptor, true
	case string(runtimes.ClaudeID):
		return runtimes.Claude(options).Descriptor, true
	case string(runtimes.OpenCodeID):
		return runtimes.OpenCode(options).Descriptor, true
	default:
		return runtimes.Descriptor{}, false
	}
}

func (s *Server) runtimeDescriptor(runtime string) (runtimes.Descriptor, bool) {
	if s.runtimeRegistry != nil {
		if registration, err := s.runtimeRegistry.Open(runtime); err == nil {
			return registration.Descriptor, true
		}
	}
	// Cached Pi/Codex sessions retain their persistence semantics even when
	// that runtime is not enabled in the current process.
	return builtinRuntimeDescriptor(runtime)
}

func (s *Server) projectionMode(runtime string) runtimes.ProjectionMode {
	descriptor, ok := s.runtimeDescriptor(runtime)
	if !ok {
		// Unknown persisted runtimes must take the conservative full-reconcile
		// path. Treating them as append-only can corrupt the browser's live
		// projection if their files are atomically replaced.
		return runtimes.ProjectionReplaceable
	}
	return descriptor.ProjectionMode
}

func (s *Server) applyRuntimeAvailability(summary *sessions.SessionSummary) {
	if summary.Runtime == "" {
		summary.Runtime = "pi"
	}
	descriptor, known := s.runtimeDescriptor(summary.Runtime)
	if !known || !descriptor.Capabilities.Chat {
		summary.ChatAvailable = false
		label := summary.Runtime
		if known {
			label = descriptor.Label
		}
		summary.ChatDisabledReason = label + " runtime does not support chat."
		return
	}
	available, reason := s.runtimeStatus(summary.Runtime)
	if available || !summary.ChatAvailable {
		return
	}
	summary.ChatAvailable = false
	if reason == "" {
		reason = summary.Runtime + " runtime is unavailable"
	}
	summary.ChatDisabledReason = "This session can be viewed, but chat is disabled because " + reason + "."
}

func (s *Server) runtimeLabel(runtime string) string {
	if descriptor, ok := s.runtimeDescriptor(runtime); ok {
		return descriptor.Label
	}
	return runtime
}

func shellArg(value string) string {
	if value != "" && safeShellArg.MatchString(value) {
		return value
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func (s *Server) terminalResumeCommand(session sessions.Session) string {
	descriptor, ok := s.runtimeDescriptor(session.Runtime)
	if !ok || !descriptor.Capabilities.Resume {
		return ""
	}
	switch session.Runtime {
	case string(runtimes.PiID):
		if session.SessionUUID == "" {
			return ""
		}
		return shellArg(descriptor.Command) + " --session " + shellArg(session.SessionUUID)
	case string(runtimes.CodexID):
		if session.NativeID == "" {
			return ""
		}
		return shellArg(descriptor.Command) + " resume " + shellArg(session.NativeID)
	case string(runtimes.ClaudeID):
		if session.NativeID == "" {
			return ""
		}
		command := shellArg(descriptor.Command) + " --resume " + shellArg(session.NativeID)
		if s.claudeHome != "" && !isDefaultClaudeHome(s.claudeHome) {
			command = "CLAUDE_CONFIG_DIR=" + shellArg(s.claudeHome) + " " + command
		}
		return command
	case string(runtimes.OpenCodeID):
		if session.NativeID == "" {
			return ""
		}
		return shellArg(descriptor.Command) + " --session " + shellArg(session.NativeID)
	default:
		return ""
	}
}

func isDefaultClaudeHome(home string) bool {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	return filepath.Clean(home) == filepath.Join(userHome, ".claude")
}

func (s *Server) handleRuntimes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	registrations := []runtimes.Registration{runtimes.Pi(runtimes.BuiltinOptions{Command: "pi"})}
	if s.runtimeRegistry != nil {
		registrations = s.runtimeRegistry.List()
	}
	entries := make([]map[string]any, 0, len(registrations))
	for _, registration := range registrations {
		descriptor := registration.Descriptor
		available, reason := s.runtimeStatus(string(descriptor.ID))
		entry := map[string]any{
			"id":             descriptor.ID,
			"label":          descriptor.Label,
			"command":        descriptor.Command,
			"available":      available,
			"projectionMode": descriptor.ProjectionMode,
			"capabilities":   descriptor.Capabilities,
		}
		if descriptor.Version != "" {
			entry["version"] = descriptor.Version
		}
		if reason != "" {
			entry["reason"] = reason
		}
		entries = append(entries, entry)
	}
	defaultRuntime := s.defaultRuntime
	if defaultRuntime == "" {
		defaultRuntime = string(runtimes.PiID)
	}
	writeJSON(w, 0, map[string]any{"defaultRuntime": defaultRuntime, "runtimes": entries})
}

func (s *Server) resolveCodexSession(w http.ResponseWriter, id string) (sessions.ResolvedSession, bool) {
	resolved, err := s.resolveSession(id)
	if resolveOrWriteError(w, err) {
		return sessions.ResolvedSession{}, false
	}
	if resolved.Session.Runtime != "codex" || resolved.Session.NativeID == "" {
		writeJSONError(w, http.StatusBadRequest, "Codex session required")
		return sessions.ResolvedSession{}, false
	}
	if _, err := s.validateSessionWorkspace(resolved); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return sessions.ResolvedSession{}, false
	}
	return resolved, true
}

func (s *Server) codexLifecycleReady(w http.ResponseWriter) bool {
	if s.codex == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "Codex runtime is unavailable")
		return false
	}
	return true
}

func (s *Server) resolveOpenCodeSession(w http.ResponseWriter, id string) (sessions.ResolvedSession, bool) {
	resolved, err := s.resolveSession(id)
	if resolveOrWriteError(w, err) {
		return sessions.ResolvedSession{}, false
	}
	if resolved.Session.Runtime != string(runtimes.OpenCodeID) || resolved.Session.NativeID == "" || resolved.Session.Project == "" {
		writeJSONError(w, http.StatusBadRequest, "OpenCode session required")
		return sessions.ResolvedSession{}, false
	}
	if project, err := s.validateSessionWorkspace(resolved); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return sessions.ResolvedSession{}, false
	} else {
		resolved.Session.Project = project
	}
	return resolved, true
}

func (s *Server) handleOpenCodeSessionDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireRuntimeCapability(w, r, string(runtimes.OpenCodeID), runtimes.CapabilityDelete) {
		return
	}
	if s.openCode == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "OpenCode runtime is unavailable")
		return
	}
	resolved, ok := s.resolveOpenCodeSession(w, r.URL.Query().Get("id"))
	if !ok {
		return
	}
	if err := s.openCode.DeleteSession(r.Context(), resolved.Session.NativeID, resolved.Session.Project); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if s.cache != nil {
		s.cache.Invalidate(resolved.Session.ID)
	}
	s.broadcast(globalSessID, "reload:"+resolved.Session.ID)
	writeJSON(w, 0, map[string]any{"ok": true})
}

func (s *Server) handleCodexThreadArchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireRuntimeCapability(w, r, string(runtimes.CodexID), runtimes.CapabilityArchive) || !s.codexLifecycleReady(w) {
		return
	}
	resolved, ok := s.resolveCodexSession(w, r.URL.Query().Get("id"))
	if !ok {
		return
	}
	if err := s.codex.ArchiveSession(r.Context(), resolved.Session.NativeID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.broadcast(globalSessID, "reload:"+resolved.Session.ID)
	writeJSON(w, 0, map[string]any{"ok": true, "nativeId": resolved.Session.NativeID})
}

func (s *Server) handleCodexThreadDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireRuntimeCapability(w, r, string(runtimes.CodexID), runtimes.CapabilityDelete) || !s.codexLifecycleReady(w) {
		return
	}
	resolved, ok := s.resolveCodexSession(w, r.URL.Query().Get("id"))
	if !ok {
		return
	}
	if err := s.codex.DeleteSession(r.Context(), resolved.Session.NativeID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.broadcast(globalSessID, "reload:"+resolved.Session.ID)
	writeJSON(w, 0, map[string]any{"ok": true})
}

func (s *Server) handleCodexThreadUnarchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireRuntimeCapability(w, r, string(runtimes.CodexID), runtimes.CapabilityUnarchive) || !s.codexLifecycleReady(w) {
		return
	}
	var body struct {
		NativeID string `json:"nativeId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.NativeID) == "" || strings.ContainsAny(body.NativeID, "/\\") {
		writeJSONError(w, http.StatusBadRequest, "valid nativeId is required")
		return
	}
	if s.workspace != nil {
		thread, err := s.codex.InspectArchivedThread(r.Context(), body.NativeID)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				writeJSONError(w, http.StatusNotFound, "thread not found")
			} else {
				writeJSONError(w, http.StatusInternalServerError, err.Error())
			}
			return
		}
		if _, err := s.resolveWorkspacePath(thread.CWD); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	projection, err := s.codex.UnarchiveSession(r.Context(), body.NativeID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeJSONError(w, http.StatusNotFound, "thread not found")
		} else {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	if s.workspace != nil {
		resolved, resolveErr := s.resolveSession(projection.ID)
		if resolveErr != nil {
			writeJSONError(w, http.StatusInternalServerError, resolveErr.Error())
			return
		}
		if _, boundaryErr := s.validateSessionWorkspace(resolved); boundaryErr != nil {
			writeJSONError(w, http.StatusBadRequest, boundaryErr.Error())
			return
		}
	}
	s.broadcast(globalSessID, "reload:"+projection.ID)
	writeJSON(w, 0, map[string]any{"ok": true, "id": projection.ID})
}

// NotifyCodexLifecycle publishes catalog-level changes that may originate in
// another Codex client and therefore have no active pican session watcher.
func (s *Server) NotifyCodexLifecycle(action, sessionID string) {
	if s.cache != nil && sessionID != "" {
		s.cache.Invalidate(sessionID)
	}
	switch action {
	case "thread/started", "thread/unarchived", "thread/materialized":
		s.broadcast(globalSessID, "new-session")
	default:
		if sessionID != "" {
			s.broadcast(globalSessID, "reload:"+sessionID)
		}
	}
	if sessionID != "" {
		s.recomputeAndBroadcastStatus(sessionID)
	}
}

// NotifyWorkerUpdate is called by runtime adapters when status or projection
// state changes outside the filesystem watcher's normal append path.
func (s *Server) NotifyWorkerUpdate(sessionID string, reload bool) {
	if reload {
		if s.cache != nil {
			s.cache.Invalidate(sessionID)
		}
		s.broadcast(sessionID, "reload")
		s.broadcast(globalSessID, "reload:"+sessionID)
	}
	s.recomputeAndBroadcastStatus(sessionID)
}
