package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"pican/internal/sessions"
)

func (s *Server) runtimeEnabled(runtime string) bool {
	if len(s.enabledRuntimes) == 0 {
		return runtime == "pi"
	}
	return s.enabledRuntimes[runtime]
}

func (s *Server) runtimeStatus(runtime string) (bool, string) {
	if !s.runtimeEnabled(runtime) {
		return false, runtime + " runtime is not enabled"
	}
	if s.runtimeAvailable == nil {
		return true, ""
	}
	return s.runtimeAvailable(runtime)
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
	runtimes := make([]map[string]any, 0, 2)
	for _, runtime := range []string{"pi", "codex"} {
		if !s.runtimeEnabled(runtime) {
			continue
		}
		available, reason := s.runtimeStatus(runtime)
		entry := map[string]any{"id": runtime, "available": available}
		if runtime == "codex" {
			entry["capabilities"] = map[string]bool{"archive": true, "unarchive": true, "delete": true}
		}
		if reason != "" {
			entry["reason"] = reason
		}
		runtimes = append(runtimes, entry)
	}
	writeJSON(w, 0, map[string]any{"defaultRuntime": s.defaultRuntime, "runtimes": runtimes})
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
