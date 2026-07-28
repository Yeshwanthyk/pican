package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"pican/internal/chat"
	"pican/internal/codex"
	"pican/internal/runtimes"
	"pican/internal/sessioncreate"
	"pican/internal/sessions"
)

const maxInitialPromptBytes = 256 << 10

type newSessionRequest struct {
	Path            string `json:"path"`
	SourceSessionID string `json:"sourceSessionId"`
	Runtime         string `json:"runtime"`
	InitialPrompt   string `json:"initialPrompt"`
}

// normalizeHostedNewSessionRequest enforces the hosted Thread-create contract
// before the idempotency store or native Codex service can be touched.
func (s *Server) normalizeHostedNewSessionRequest(body *newSessionRequest) error {
	if !s.hosted {
		return nil
	}
	if s.workspace == nil || s.workspaceRoot == "" {
		return errors.New("hosted workspace is unavailable")
	}
	if strings.TrimSpace(body.SourceSessionID) != "" {
		return errors.New("sourceSessionId is not supported in hosted mode")
	}
	runtime := strings.TrimSpace(body.Runtime)
	if runtime == "" {
		runtime = string(runtimes.CodexID)
	}
	if runtime != string(runtimes.CodexID) {
		return errors.New("hosted session creation supports only the Codex runtime")
	}
	path := strings.TrimSpace(body.Path)
	if path == "" {
		path = s.workspaceRoot
	}
	canonical, err := s.workspace.ResolveForCreation(path)
	if err != nil {
		return err
	}
	if canonical != s.workspaceRoot {
		return errors.New("path must equal the hosted workspace root")
	}
	body.Path = s.workspaceRoot
	body.SourceSessionID = ""
	body.Runtime = string(runtimes.CodexID)
	return nil
}

func (s *Server) initialSettingsFromSource(ctx context.Context, sourceSessionID, targetRuntime string) sessions.InitialSettings {
	if s.chatSender == nil || sourceSessionID == "" {
		return sessions.InitialSettings{}
	}
	resolved, err := s.resolveSession(sourceSessionID)
	if err != nil || resolved.Session.Runtime != targetRuntime {
		return sessions.InitialSettings{}
	}
	if s.workspace != nil {
		if _, err := s.validateSessionWorkspace(resolved); err != nil {
			return sessions.InitialSettings{}
		}
	}
	state, err := s.chatSender.GetState(ctx, sourceSessionID)
	if err != nil {
		return sessions.InitialSettings{}
	}
	return sessions.InitialSettings{
		ModelProvider: state.ModelProvider,
		ModelID:       state.Model,
		ThinkingLevel: state.ThinkingLevel,
	}
}

func (s *Server) initializeNewSessionWorker(ctx context.Context, sessionID, sessionPath string, settings sessions.InitialSettings) {
	if s.chatSender == nil {
		return
	}
	if s.workspace != nil {
		resolved, err := s.resolveSession(sessionID)
		if err != nil {
			return
		}
		if _, err := s.validateSessionWorkspace(resolved); err != nil {
			return
		}
		sessionPath = resolved.Path
	}
	// The settings have already been written into the new session file as
	// implicit entries. Creating/switching the worker should pick them up from
	// the session history. Do not call SetModel/SetThinkingLevel here: those RPC
	// calls append visible "Switched to model" entries and duplicate the implicit
	// initial settings.
	workerCtx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	_ = s.chatSender.EnsureWorker(workerCtx, sessionID, sessionPath)
}

func (s *Server) handleIdempotentCodexCreate(
	w http.ResponseWriter,
	r *http.Request,
	body newSessionRequest,
	settings sessions.InitialSettings,
) {
	key := r.Header.Get("Idempotency-Key")
	if err := sessioncreate.ValidateKey(key); err != nil {
		writeJSONError(w, http.StatusBadRequest, "a valid Idempotency-Key header is required")
		return
	}
	if s.sessionCreates == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "idempotent session creation is unavailable")
		return
	}
	if body.Runtime != string(runtimes.CodexID) {
		writeJSONError(w, http.StatusConflict, "idempotent session creation is supported only for the Codex runtime")
		return
	}
	if s.codex == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "Codex runtime is unavailable")
		return
	}

	prompt := strings.TrimSpace(body.InitialPrompt)
	if len(prompt) > maxInitialPromptBytes {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "initialPrompt is too large")
		return
	}

	normalizedPath := body.Path
	var err error
	if s.hosted {
		if err = s.normalizeHostedNewSessionRequest(&body); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		normalizedPath = body.Path
	} else if s.workspace != nil {
		normalizedPath, err = s.workspace.ResolveForCreation(body.Path)
	} else {
		// Standalone idempotent callers retain the existing create-path
		// behavior. Hosted callers take the no-write normalization path above.
		normalizedPath, err = s.prepareSessionPath(body.Path)
	}
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	fingerprint, err := sessioncreate.Fingerprint(struct {
		Path            string `json:"path"`
		SourceSessionID string `json:"sourceSessionId,omitempty"`
		Runtime         string `json:"runtime"`
		InitialPrompt   string `json:"initialPrompt,omitempty"`
	}{
		Path:            normalizedPath,
		SourceSessionID: strings.TrimSpace(body.SourceSessionID),
		Runtime:         string(runtimes.CodexID),
		InitialPrompt:   prompt,
	})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "normalize session creation request")
		return
	}

	existing, getErr := s.sessionCreates.Get(r.Context(), key)
	switch {
	case getErr == nil && existing.Fingerprint != fingerprint:
		writeJSONError(w, http.StatusConflict, sessioncreate.ErrConflict.Error())
		return
	case errors.Is(getErr, sessioncreate.ErrRecordMissing):
		if capabilityErr := s.runtimeCapabilityError(r.Context(), string(runtimes.CodexID), runtimes.CapabilityCreate); capabilityErr != nil {
			writeRuntimeOperationError(w, capabilityErr)
			return
		}
	case getErr != nil:
		writeJSONError(w, http.StatusInternalServerError, "read session creation intent")
		return
	}

	claim, err := s.sessionCreates.Claim(r.Context(), key, fingerprint, string(runtimes.CodexID), prompt != "")
	if errors.Is(err, sessioncreate.ErrConflict) {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "persist session creation intent")
		return
	}
	record := claim.Record
	if claim.Owner {
		cwd := normalizedPath
		if !s.hosted {
			var pathErr error
			cwd, pathErr = s.prepareSessionPath(normalizedPath)
			if pathErr != nil {
				s.markCreateUnknown(key, fingerprint)
				writeJSONError(w, http.StatusServiceUnavailable, "session creation state is unknown")
				return
			}
		}
		model := settings.ModelID
		if settings.ModelProvider != "" && settings.ModelProvider != codex.Provider {
			model = ""
		}
		projection, startErr := s.codex.StartSession(r.Context(), cwd, model, settings.ThinkingLevel)
		if startErr != nil {
			s.markCreateUnknown(key, fingerprint)
			writeJSONError(w, http.StatusServiceUnavailable, "session creation state is unknown")
			return
		}
		persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)
		record, err = s.sessionCreates.MarkCreated(
			persistCtx,
			key,
			fingerprint,
			projection.ID,
			string(runtimes.CodexID),
			projection.NativeID,
		)
		persistCancel()
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "persist native session identity")
			return
		}
	} else if record.CreateState == sessioncreate.CreateStateCreating {
		waitCtx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		record, err = s.sessionCreates.WaitForMapping(waitCtx, key, fingerprint, 10*time.Millisecond)
		cancel()
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			writeIdempotentCreateResponse(w, http.StatusAccepted, record)
			return
		}
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "read session creation state")
			return
		}
	}
	if record.CreateState == sessioncreate.CreateStateUnknown {
		writeIdempotentCreateResponse(w, http.StatusServiceUnavailable, record)
		return
	}
	if record.CreateState != sessioncreate.CreateStateCreated {
		writeIdempotentCreateResponse(w, http.StatusAccepted, record)
		return
	}

	resolved, resolveErr := s.resolveSession(record.SessionID)
	if resolveErr != nil {
		writeJSONError(w, http.StatusServiceUnavailable, "created session projection is unavailable")
		return
	}
	if _, boundaryErr := s.validateSessionWorkspace(resolved); boundaryErr != nil {
		writeJSONError(w, http.StatusBadRequest, boundaryErr.Error())
		return
	}
	if !s.hosted && resolved.Session.Project != "" && s.trackProject(resolved.Session.Project) == nil {
		s.publishCurationUpdated()
	}

	if record.PromptState == sessioncreate.PromptStatePending {
		if s.chatSender == nil {
			writeJSONError(w, http.StatusServiceUnavailable, "initial prompt dispatch is unavailable")
			return
		}
		if capabilityErr := s.runtimeCapabilityError(r.Context(), string(runtimes.CodexID), runtimes.CapabilityChat); capabilityErr != nil {
			writeRuntimeOperationError(w, capabilityErr)
			return
		}
		var dispatch bool
		record, dispatch, err = s.sessionCreates.BeginPromptDispatch(r.Context(), key, fingerprint)
		if err != nil {
			writeJSONError(w, http.StatusInternalServerError, "persist initial prompt dispatch")
			return
		}
		if dispatch {
			dispatchCtx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
			sendErr := s.chatSender.Send(dispatchCtx, record.SessionID, resolved.Path, chat.Request{Message: prompt})
			cancel()
			if sendErr != nil {
				record = s.markPromptUnknown(key, fingerprint, record)
				writeIdempotentCreateResponse(w, http.StatusAccepted, record)
				return
			}
			persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)
			record, err = s.sessionCreates.MarkPromptAccepted(persistCtx, key, fingerprint)
			persistCancel()
			if err != nil {
				writeJSONError(w, http.StatusInternalServerError, "persist initial prompt acceptance")
				return
			}
		}
	} else if claim.Owner && record.PromptState == sessioncreate.PromptStateNotRequested {
		go s.initializeNewSessionWorker(context.Background(), resolved.Session.ID, resolved.Path, settings)
	}

	if record.PromptState == sessioncreate.PromptStateDispatching {
		waitCtx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
		resolvedRecord, waitErr := s.sessionCreates.WaitForPromptResolution(waitCtx, key, fingerprint, 10*time.Millisecond)
		cancel()
		if waitErr == nil {
			record = resolvedRecord
		} else if !errors.Is(waitErr, context.Canceled) && !errors.Is(waitErr, context.DeadlineExceeded) {
			writeJSONError(w, http.StatusInternalServerError, "read initial prompt dispatch state")
			return
		}
	}

	status := http.StatusOK
	if record.PromptState == sessioncreate.PromptStateDispatching ||
		record.PromptState == sessioncreate.PromptStateUnknown {
		status = http.StatusAccepted
	}
	writeIdempotentCreateResponse(w, status, record)
}

func (s *Server) markCreateUnknown(key, fingerprint string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.sessionCreates.MarkCreateUnknown(ctx, key, fingerprint)
}

func (s *Server) markPromptUnknown(key, fingerprint string, fallback sessioncreate.Record) sessioncreate.Record {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	record, err := s.sessionCreates.MarkPromptUnknown(ctx, key, fingerprint)
	if err != nil {
		return fallback
	}
	return record
}

func writeIdempotentCreateResponse(w http.ResponseWriter, status int, record sessioncreate.Record) {
	writeJSON(w, status, map[string]any{
		"ok":                  record.CreateState == sessioncreate.CreateStateCreated,
		"id":                  record.SessionID,
		"runtime":             record.Runtime,
		"nativeId":            record.NativeID,
		"createState":         record.CreateState,
		"promptDispatchState": record.PromptState,
	})
}
