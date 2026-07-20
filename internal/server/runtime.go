package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"pican/internal/runtimes"
	"pican/internal/sessions"
	"pican/internal/workers"
)

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

func builtinRuntimeDescriptor(runtime string) (runtimes.Descriptor, bool) {
	options := runtimes.BuiltinOptions{Command: runtime}
	switch runtime {
	case string(runtimes.PiID):
		return runtimes.Pi(options).Descriptor, true
	case string(runtimes.CodexID):
		return runtimes.Codex(options).Descriptor, true
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
	var resolved sessions.ResolvedSession
	var err error
	if s.cache != nil {
		resolved, err = s.cache.Resolve(s.sessionsDir, id)
	} else {
		resolved, err = sessions.ResolveByID(s.sessionsDir, id)
	}
	if resolveOrWriteError(w, err) {
		return sessions.ResolvedSession{}, false
	}
	if resolved.Session.Runtime != "codex" || resolved.Session.NativeID == "" {
		writeJSONError(w, http.StatusBadRequest, "Codex session required")
		return sessions.ResolvedSession{}, false
	}
	return resolved, true
}

func (s *Server) codexLifecycleReady(w http.ResponseWriter) bool {
	if s.codex == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "Codex runtime is unavailable")
		return false
	}
	if available, reason := s.runtimeStatus("codex"); !available {
		writeJSONError(w, http.StatusServiceUnavailable, reason)
		return false
	}
	return true
}

func (s *Server) handleCodexThreadArchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || !s.codexLifecycleReady(w) {
		if r.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
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
	if r.Method != http.MethodPost || !s.codexLifecycleReady(w) {
		if r.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
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
	if r.Method != http.MethodPost || !s.codexLifecycleReady(w) {
		if r.Method != http.MethodPost {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
		return
	}
	var body struct {
		NativeID string `json:"nativeId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.NativeID) == "" || strings.ContainsAny(body.NativeID, "/\\") {
		writeJSONError(w, http.StatusBadRequest, "valid nativeId is required")
		return
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
