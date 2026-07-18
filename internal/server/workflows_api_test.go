package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeWorkflowTestFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func TestHandleApiWorkflowsListsValidRuns(t *testing.T) {
	s := newTestServer(t)
	workflowsDir := filepath.Join(s.agentDir, "workflows")
	older := filepath.Join(workflowsDir, "wf_aaaaaaaaaaaa")
	newer := filepath.Join(workflowsDir, "wf_bbbbbbbbbbbb")
	writeWorkflowTestFile(t, filepath.Join(older, "workflow.json"), `{
		"runId":"wf_aaaaaaaaaaaa","name":"Older","status":"completed",
		"startedAt":"2026-07-16T10:00:00Z","finishedAt":"2026-07-16T10:01:00Z",
		"currentPhase":"Ship","phases":[{"title":"Build"},{"title":"Ship"}],
		"agents":[{"label":"one"}]
	}`)
	writeWorkflowTestFile(t, filepath.Join(older, "result.json"), `{"ok":true}`)
	writeWorkflowTestFile(t, filepath.Join(newer, "workflow.json"), `{
		"runId":"wf_bbbbbbbbbbbb","name":"Newer","description":"Latest run",
		"status":"running","startedAt":"2026-07-17T10:00:00Z",
		"phases":[{"title":"Research"}],"agents":[{"label":"one"},{"label":"two"}]
	}`)
	writeWorkflowTestFile(t, filepath.Join(newer, "transcripts.json"), `{"0":[]}`)
	writeWorkflowTestFile(t, filepath.Join(workflowsDir, "wf_cccccccccccc", "workflow.json"), `{bad json`)

	req := httptest.NewRequest(http.MethodGet, "/api/workflows", nil)
	w := httptest.NewRecorder()
	s.handleApiWorkflows(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Workflows []workflowSummary `json:"workflows"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Workflows) != 2 {
		t.Fatalf("workflows = %d, want 2", len(response.Workflows))
	}
	if response.Workflows[0].RunID != "wf_bbbbbbbbbbbb" {
		t.Fatalf("first run = %q, want newest", response.Workflows[0].RunID)
	}
	if response.Workflows[0].PhaseCount != 1 || response.Workflows[0].AgentCount != 2 || !response.Workflows[0].HasTranscripts {
		t.Fatalf("unexpected newer summary: %+v", response.Workflows[0])
	}
	if !response.Workflows[1].HasResult {
		t.Fatalf("expected older run to report result: %+v", response.Workflows[1])
	}
}

func TestHandleApiWorkflowsFiltersBySessionFilename(t *testing.T) {
	s := newTestServer(t)
	workflowsDir := filepath.Join(s.agentDir, "workflows")
	writeWorkflowTestFile(t, filepath.Join(workflowsDir, "wf_aaaaaaaaaaaa", "workflow.json"), `{
		"runId":"wf_aaaaaaaaaaaa","sessionId":"019f6af1-290d-7c63-a029-65da984aa074",
		"name":"Matching","status":"completed"
	}`)
	writeWorkflowTestFile(t, filepath.Join(workflowsDir, "wf_bbbbbbbbbbbb", "workflow.json"), `{
		"runId":"wf_bbbbbbbbbbbb","sessionId":"other-session",
		"name":"Unrelated","status":"completed"
	}`)

	req := httptest.NewRequest(http.MethodGet, "/api/workflows?session=2026-07-17T12-00-00.000Z_019f6af1-290d-7c63-a029-65da984aa074.jsonl", nil)
	w := httptest.NewRecorder()
	s.handleApiWorkflows(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Workflows []workflowSummary `json:"workflows"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Workflows) != 1 || response.Workflows[0].RunID != "wf_aaaaaaaaaaaa" {
		t.Fatalf("unexpected filtered workflows: %+v", response.Workflows)
	}
}

func TestHandleApiWorkflowRunRejectsInvalidRunID(t *testing.T) {
	s := newTestServer(t)
	for _, runID := range []string{"", "../secret", "wf_ABCDEF123456", "wf_short"} {
		req := httptest.NewRequest(http.MethodGet, "/api/workflows/run?runId="+runID, nil)
		w := httptest.NewRecorder()
		s.handleApiWorkflowRun(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("runId %q status = %d, want 400", runID, w.Code)
		}
	}
}

func TestHandleApiWorkflowRunNotFound(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/workflows/run?runId=wf_aaaaaaaaaaaa", nil)
	w := httptest.NewRecorder()
	s.handleApiWorkflowRun(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404: %s", w.Code, w.Body.String())
	}
}

func TestHandleApiWorkflowRunReturnsDetail(t *testing.T) {
	s := newTestServer(t)
	runID := "wf_123456abcdef"
	runDir := filepath.Join(s.agentDir, "workflows", runID)
	writeWorkflowTestFile(t, filepath.Join(runDir, "workflow.json"), `{"runId":"wf_123456abcdef","sessionId":"session-1","name":"Demo","status":"completed"}`)
	writeWorkflowTestFile(t, filepath.Join(runDir, "transcripts.json"), `{"0":[{"role":"assistant","text":"Done"}]}`)
	writeWorkflowTestFile(t, filepath.Join(runDir, "result.json"), `{"answer":42}`)
	writeWorkflowTestFile(t, filepath.Join(runDir, "script.js"), `export default async function () { return 42 }`)

	req := httptest.NewRequest(http.MethodGet, "/api/workflows/run?runId="+runID, nil)
	w := httptest.NewRecorder()
	s.handleApiWorkflowRun(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Workflow struct {
			RunID     string `json:"runId"`
			SessionID string `json:"sessionId"`
		} `json:"workflow"`
		Transcripts map[string][]map[string]any `json:"transcripts"`
		Result      map[string]any              `json:"result"`
		Script      string                      `json:"script"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Workflow.RunID != runID || response.Workflow.SessionID != "session-1" {
		t.Fatalf("unexpected workflow: %+v", response.Workflow)
	}
	if len(response.Transcripts["0"]) != 1 || response.Result["answer"] != float64(42) {
		t.Fatalf("unexpected detail payload: %+v", response)
	}
	if response.Script == "" {
		t.Fatal("expected script contents")
	}
}

func TestWorkflowTimeAcceptsEpochMillisAndRFC3339(t *testing.T) {
	var snapshot workflowSnapshot
	data := []byte(`{"runId":"wf_0123456789ab","status":"completed","startedAt":1784315767306,"finishedAt":"2026-07-17T21:42:54.322Z"}`)
	if err := json.Unmarshal(data, &snapshot); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if snapshot.StartedAt.IsZero() || snapshot.StartedAt.UnixMilli() != 1784315767306 {
		t.Fatalf("epoch millis not parsed: %v", snapshot.StartedAt)
	}
	if snapshot.FinishedAt.IsZero() {
		t.Fatal("RFC3339 not parsed")
	}
	out, err := json.Marshal(snapshot.StartedAt)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(out) == `""` {
		t.Fatal("expected RFC3339 output, got empty string")
	}
}
