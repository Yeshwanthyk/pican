package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

var workflowRunIDPattern = regexp.MustCompile(`^wf_[0-9a-f]{12}$`)

type workflowSummary struct {
	RunID          string `json:"runId"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	Status         string `json:"status"`
	StartedAt      string `json:"startedAt"`
	FinishedAt     string `json:"finishedAt"`
	CurrentPhase   string `json:"currentPhase"`
	CurrentPhaseNo int    `json:"currentPhaseNumber"`
	PhaseCount     int    `json:"phaseCount"`
	AgentCount     int    `json:"agentCount"`
	HasResult      bool   `json:"hasResult"`
	HasTranscripts bool   `json:"hasTranscripts"`

	startedTime time.Time
}

type workflowSnapshot struct {
	RunID        string            `json:"runId"`
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Status       string            `json:"status"`
	StartedAt    string            `json:"startedAt"`
	FinishedAt   string            `json:"finishedAt"`
	CurrentPhase string            `json:"currentPhase"`
	Phases       []json.RawMessage `json:"phases"`
	Agents       []json.RawMessage `json:"agents"`
}

func (s *Server) workflowsDir() string {
	return filepath.Join(s.agentDir, "workflows")
}

func readWorkflowJSON(path string) (json.RawMessage, workflowSnapshot, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, workflowSnapshot{}, err
	}
	var snapshot workflowSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, workflowSnapshot{}, err
	}
	if !workflowRunIDPattern.MatchString(snapshot.RunID) ||
		(snapshot.Status != "running" && snapshot.Status != "completed" && snapshot.Status != "failed") {
		return nil, workflowSnapshot{}, errors.New("workflow snapshot is missing a valid runId or status")
	}
	return json.RawMessage(data), snapshot, nil
}

func regularFileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func currentWorkflowPhaseNumber(snapshot workflowSnapshot) int {
	if snapshot.Status == "completed" {
		return len(snapshot.Phases)
	}
	for index, raw := range snapshot.Phases {
		var phase struct {
			Title string `json:"title"`
		}
		if json.Unmarshal(raw, &phase) == nil && phase.Title == snapshot.CurrentPhase {
			return index + 1
		}
	}
	return 0
}

func (s *Server) handleApiWorkflows(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	entries, err := os.ReadDir(s.workflowsDir())
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, 0, map[string]any{"workflows": []workflowSummary{}})
			return
		}
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	workflows := make([]workflowSummary, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !workflowRunIDPattern.MatchString(entry.Name()) {
			continue
		}
		runDir := filepath.Join(s.workflowsDir(), entry.Name())
		_, snapshot, err := readWorkflowJSON(filepath.Join(runDir, "workflow.json"))
		if err != nil || snapshot.RunID != entry.Name() {
			continue
		}
		startedTime, _ := time.Parse(time.RFC3339Nano, snapshot.StartedAt)
		workflows = append(workflows, workflowSummary{
			RunID:          snapshot.RunID,
			Name:           snapshot.Name,
			Description:    snapshot.Description,
			Status:         snapshot.Status,
			StartedAt:      snapshot.StartedAt,
			FinishedAt:     snapshot.FinishedAt,
			CurrentPhase:   snapshot.CurrentPhase,
			CurrentPhaseNo: currentWorkflowPhaseNumber(snapshot),
			PhaseCount:     len(snapshot.Phases),
			AgentCount:     len(snapshot.Agents),
			HasResult:      regularFileExists(filepath.Join(runDir, "result.json")),
			HasTranscripts: regularFileExists(filepath.Join(runDir, "transcripts.json")),
			startedTime:    startedTime,
		})
	}

	sort.SliceStable(workflows, func(i, j int) bool {
		iMissing := workflows[i].startedTime.IsZero()
		jMissing := workflows[j].startedTime.IsZero()
		if iMissing != jMissing {
			return !iMissing
		}
		return workflows[i].startedTime.After(workflows[j].startedTime)
	})
	writeJSON(w, 0, map[string]any{"workflows": workflows})
}

func readOptionalJSON(path string) (any, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func readOptionalString(path string) (any, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return string(data), nil
}

func (s *Server) handleApiWorkflowRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	runID := r.URL.Query().Get("runId")
	if !workflowRunIDPattern.MatchString(runID) {
		writeJSONError(w, http.StatusBadRequest, "invalid runId")
		return
	}

	runDir := filepath.Join(s.workflowsDir(), runID)
	workflow, snapshot, err := readWorkflowJSON(filepath.Join(runDir, "workflow.json"))
	if os.IsNotExist(err) {
		writeJSONError(w, http.StatusNotFound, "workflow not found")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if snapshot.RunID != runID {
		writeJSONError(w, http.StatusNotFound, "workflow not found")
		return
	}

	transcripts, err := readOptionalJSON(filepath.Join(runDir, "transcripts.json"))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	result, err := readOptionalJSON(filepath.Join(runDir, "result.json"))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	script, err := readOptionalString(filepath.Join(runDir, "script.js"))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, 0, map[string]any{
		"workflow":    workflow,
		"transcripts": transcripts,
		"result":      result,
		"script":      script,
	})
}
