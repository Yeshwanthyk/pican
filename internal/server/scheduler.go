package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"pican/internal/chat"
	"pican/internal/codex"
	"pican/internal/opencode"
	"pican/internal/runtimes"
	"pican/internal/schedules"
	"pican/internal/sessions"
)

// scheduleTickInterval is how often the scheduler re-evaluates due schedules.
// Cron is minute-resolution, so a sub-minute tick keeps firing within a few
// seconds of the target time.
const scheduleTickInterval = 30 * time.Second

// scheduleWorkerTimeout bounds the EnsureWorker step when a schedule fires.
const scheduleWorkerTimeout = 60 * time.Second

// scheduleState tracks, per schedule, the next time it should fire and the
// cron/timezone signature it was computed from (so edits force a recompute).
type scheduleState struct {
	next time.Time
	sig  string
}

func scheduleSig(sc schedules.Schedule) string {
	return sc.CronExpr + "|" + sc.Timezone
}

// runScheduler ticks until stopped, firing any schedule whose next occurrence
// has arrived. Missed occurrences (while the process was down) are skipped:
// a schedule's first evaluation computes its next fire from now, never the past.
func (s *Server) runScheduler(stop <-chan struct{}, interval time.Duration) {
	state := make(map[string]scheduleState)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		s.evaluateSchedules(state)
		select {
		case <-ticker.C:
		case <-stop:
			return
		}
	}
}

func (s *Server) evaluateSchedules(state map[string]scheduleState) {
	if s.schedules == nil {
		return
	}
	list, err := s.schedules.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "scheduler: list schedules: %v\n", err)
		return
	}
	now := s.now()
	seen := make(map[string]bool, len(list))
	for _, sc := range list {
		seen[sc.ID] = true
		if !sc.Enabled || sc.IsManual() {
			delete(state, sc.ID)
			continue
		}
		sig := scheduleSig(sc)
		st, ok := state[sc.ID]
		if !ok || st.sig != sig {
			next, err := schedules.NextFire(sc.CronExpr, sc.Timezone, now)
			if err != nil {
				fmt.Fprintf(os.Stderr, "scheduler: %q invalid cron %q: %v\n", sc.Name, sc.CronExpr, err)
				delete(state, sc.ID)
				continue
			}
			state[sc.ID] = scheduleState{next: next, sig: sig}
			continue
		}
		if now.Before(st.next) {
			continue
		}
		sc := sc
		go func() {
			if _, err := s.fireSchedule(sc); err != nil {
				fmt.Fprintf(os.Stderr, "scheduler: fire %q: %v\n", sc.Name, err)
			}
		}()
		next, err := schedules.NextFire(sc.CronExpr, sc.Timezone, now)
		if err != nil {
			delete(state, sc.ID)
			continue
		}
		state[sc.ID] = scheduleState{next: next, sig: sig}
	}
	for id := range state {
		if !seen[id] {
			delete(state, id)
		}
	}
}

// scheduleNameForSession reports whether a session was created by a schedule,
// returning the schedule's name. Used to route schedule-specific notifications.
func (s *Server) scheduleNameForSession(sessionID string) (string, bool) {
	if s.schedules == nil {
		return "", false
	}
	return s.schedules.ScheduleNameForSession(sessionID)
}

func (s *Server) scheduleRuntime(modelProvider string) string {
	if modelProvider == codex.Provider {
		return string(runtimes.CodexID)
	}
	if modelProvider == opencode.Provider {
		return string(runtimes.OpenCodeID)
	}
	if s.defaultRuntime != "" {
		return s.defaultRuntime
	}
	return string(runtimes.PiID)
}

func (s *Server) scheduleCapabilityError(ctx context.Context, sc schedules.Schedule) error {
	runtime := s.scheduleRuntime(sc.ModelProvider)
	// Scheduling needs an explicit creation adapter, not merely create/chat
	// capability flags. Claude scheduling remains deferred until its product
	// surface can select the runtime independently from provider/model data.
	if runtime != string(runtimes.PiID) && runtime != string(runtimes.CodexID) && runtime != string(runtimes.OpenCodeID) {
		return &runtimeOperationFailure{
			status:  409,
			message: s.runtimeLabel(runtime) + " runtime does not support schedules",
		}
	}
	for _, capability := range []runtimes.Capability{runtimes.CapabilityCreate, runtimes.CapabilityChat} {
		if err := s.runtimeCapabilityError(ctx, runtime, capability); err != nil {
			return err
		}
	}
	if sc.ModelID != "" {
		if err := s.runtimeCapabilityError(ctx, runtime, runtimes.CapabilityModelSwitching); err != nil {
			return err
		}
	}
	if sc.ThinkingLevel != "" {
		if err := s.runtimeThinkingCapabilityError(ctx, runtime); err != nil {
			return err
		}
	}
	return nil
}

// fireSchedule creates a fresh session for the schedule's selected runtime,
// records the run, and sends the instructions as the first message. Returns the
// created session's UUID. Used by both the timer and the Run-now endpoint.
func (s *Server) fireSchedule(sc schedules.Schedule) (string, error) {
	if s.schedules == nil {
		return "", errors.New("schedules unavailable")
	}
	fired := s.now().UTC()
	runID, err := s.schedules.RecordRun(schedules.Run{
		ScheduleID: sc.ID,
		FiredAt:    fired.Format(time.RFC3339),
		Status:     schedules.RunStatusRunning,
	})
	if err != nil {
		return "", fmt.Errorf("record run: %w", err)
	}
	_ = s.schedules.SetLastRun(sc.ID, fired)

	path := strings.TrimSpace(sc.ProjectPath)
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			_ = s.schedules.FailRun(runID, err.Error())
			return "", err
		}
		path = home
	}

	settings := sessions.InitialSettings{
		ModelProvider: sc.ModelProvider,
		ModelID:       sc.ModelID,
		ThinkingLevel: sc.ThinkingLevel,
	}
	runtime := s.scheduleRuntime(sc.ModelProvider)
	if capabilityErr := s.scheduleCapabilityError(context.Background(), sc); capabilityErr != nil {
		err := capabilityErr
		_ = s.schedules.FailRun(runID, err.Error())
		return "", err
	}
	var filename string
	switch runtime {
	case string(runtimes.CodexID):
		if s.codex == nil {
			err := errors.New("Codex runtime is unavailable")
			_ = s.schedules.FailRun(runID, err.Error())
			return "", err
		}
		cwd, pathErr := sessions.PrepareSessionPath(path)
		if pathErr != nil {
			_ = s.schedules.FailRun(runID, pathErr.Error())
			return "", pathErr
		}
		model := settings.ModelID
		if settings.ModelProvider != "" && settings.ModelProvider != codex.Provider {
			model = ""
		}
		createCtx, cancelCreate := context.WithTimeout(context.Background(), scheduleWorkerTimeout)
		projection, startErr := s.codex.StartSession(createCtx, cwd, model, settings.ThinkingLevel)
		cancelCreate()
		if startErr != nil {
			_ = s.schedules.FailRun(runID, startErr.Error())
			return "", fmt.Errorf("create Codex session: %w", startErr)
		}
		filename = projection.ID
	case string(runtimes.OpenCodeID):
		if s.openCode == nil {
			err := errors.New("OpenCode runtime is unavailable")
			_ = s.schedules.FailRun(runID, err.Error())
			return "", err
		}
		cwd, pathErr := sessions.PrepareSessionPath(path)
		if pathErr != nil {
			_ = s.schedules.FailRun(runID, pathErr.Error())
			return "", pathErr
		}
		model := settings.ModelID
		if settings.ModelProvider != "" && settings.ModelProvider != opencode.Provider {
			model = ""
		}
		createCtx, cancelCreate := context.WithTimeout(context.Background(), scheduleWorkerTimeout)
		projection, startErr := s.openCode.StartSession(createCtx, cwd, model)
		cancelCreate()
		if startErr != nil {
			_ = s.schedules.FailRun(runID, startErr.Error())
			return "", fmt.Errorf("create OpenCode session: %w", startErr)
		}
		filename = projection.ID
	case string(runtimes.PiID):
		filename, err = sessions.CreateSessionFileWithSettings(s.sessionsDir, path, settings)
		if err != nil {
			_ = s.schedules.FailRun(runID, err.Error())
			return "", fmt.Errorf("create session: %w", err)
		}
	default:
		err = &runtimeOperationFailure{status: 409, message: s.runtimeLabel(runtime) + " runtime does not support create"}
		_ = s.schedules.FailRun(runID, err.Error())
		return "", err
	}
	resolved, err := s.resolveSession(filename)
	if err != nil {
		_ = s.schedules.FailRun(runID, err.Error())
		return "", fmt.Errorf("resolve session: %w", err)
	}
	sessionID := resolved.Session.ID
	if err := s.schedules.AttachSession(runID, sessionID, filename); err != nil {
		fmt.Fprintf(os.Stderr, "scheduler: attach session: %v\n", err)
	}

	if s.chatSender == nil {
		_ = s.schedules.FailRun(runID, "chat unavailable")
		return sessionID, errors.New("chat unavailable")
	}
	workerCtx, cancel := context.WithTimeout(context.Background(), scheduleWorkerTimeout)
	defer cancel()
	if err := s.chatSender.EnsureWorker(workerCtx, sessionID, resolved.Path); err != nil {
		_ = s.schedules.FailRun(runID, err.Error())
		return sessionID, fmt.Errorf("ensure worker: %w", err)
	}
	if err := s.chatSender.Send(context.Background(), sessionID, resolved.Path, chat.Request{Message: sc.Instructions}); err != nil {
		_ = s.schedules.FailRun(runID, err.Error())
		return sessionID, fmt.Errorf("send: %w", err)
	}
	return sessionID, nil
}
