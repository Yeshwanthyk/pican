package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeSubagentSession(t *testing.T, sessionsDir, projectDir, filename, contents string) {
	t.Helper()
	dir := filepath.Join(sessionsDir, filepath.Base(projectDir))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func fetchSubagents(t *testing.T, s *Server) []subagentSummary {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/subagents", nil)
	w := httptest.NewRecorder()
	s.handleApiSubagents(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Subagents []subagentSummary `json:"subagents"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response.Subagents
}

func TestHandleApiSubagentsMergesParentAndChild(t *testing.T) {
	s := newTestServer(t)
	s.now = func() time.Time { return time.Date(2026, 7, 17, 13, 0, 0, 0, time.UTC) }
	parentProject := filepath.Join(t.TempDir(), "parent")
	childProject := filepath.Join(t.TempDir(), "child")
	parent := fmt.Sprintf(
		"{\"type\":\"session\",\"id\":\"parent-id\",\"timestamp\":\"2026-07-17T11:59:00Z\",\"cwd\":%q}\n"+
			"{\"type\":\"message\",\"timestamp\":\"2026-07-17T12:00:00Z\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"subagent_spawn\",\"details\":{\"id\":\"sa-1\",\"title\":\"Review API\",\"cwd\":%q,\"harness\":\"pi\",\"model\":\"test\"}}}\n"+
			"{\"type\":\"custom_message\",\"timestamp\":\"2026-07-17T12:04:00Z\",\"customType\":\"subagent-result\",\"details\":{\"id\":\"sa-1\",\"title\":\"Review API\",\"status\":\"done\"}}\n",
		parentProject,
		childProject,
	)
	child := fmt.Sprintf(
		"{\"type\":\"session\",\"id\":\"child-id\",\"timestamp\":\"2026-07-17T12:02:00Z\",\"cwd\":%q}\n"+
			"{\"type\":\"session_info\",\"timestamp\":\"2026-07-17T12:02:01Z\",\"name\":\"subagent: Review API\"}\n"+
			"{\"type\":\"message\",\"timestamp\":\"2026-07-17T12:03:00Z\",\"message\":{\"role\":\"assistant\",\"content\":\"Done\"}}\n",
		childProject,
	)
	writeSubagentSession(t, s.sessionsDir, parentProject, "parent.jsonl", parent)
	writeSubagentSession(t, s.sessionsDir, childProject, "child.jsonl", child)

	items := fetchSubagents(t, s)
	if len(items) != 1 {
		t.Fatalf("subagents = %d, want 1: %+v", len(items), items)
	}
	got := items[0]
	if got.ID != "sa-1" || got.Title != "Review API" || got.Harness != "pi" || got.Status != "done" {
		t.Fatalf("unexpected merged identity/status: %+v", got)
	}
	if got.ParentSession != "parent.jsonl" || got.ParentProject != parentProject {
		t.Fatalf("unexpected parent fields: %+v", got)
	}
	if got.ChildSession != "child.jsonl" || got.ChildProject != childProject {
		t.Fatalf("unexpected child fields: %+v", got)
	}
	if got.SpawnedAt != "2026-07-17T12:00:00Z" || got.LastActivity != "2026-07-17T12:04:00Z" {
		t.Fatalf("unexpected timestamps: %+v", got)
	}
}

func TestHandleApiSubagentsMapsRunningErrorAndUnknownStatuses(t *testing.T) {
	s := newTestServer(t)
	s.now = func() time.Time { return time.Date(2026, 7, 17, 13, 0, 0, 0, time.UTC) }
	project := filepath.Join(t.TempDir(), "project")
	parent := fmt.Sprintf(
		"{\"type\":\"session\",\"timestamp\":\"2026-07-17T12:00:00Z\",\"cwd\":%q}\n"+
			"{\"type\":\"message\",\"timestamp\":\"2026-07-17T12:01:00Z\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"subagent_spawn\",\"details\":{\"id\":\"sa-error\",\"title\":\"Claude child\",\"harness\":\"claude\"}}}\n"+
			"{\"type\":\"custom_message\",\"timestamp\":\"2026-07-17T12:02:00Z\",\"customType\":\"subagent-result\",\"details\":{\"id\":\"sa-error\",\"status\":\"error\"}}\n"+
			"{\"type\":\"message\",\"timestamp\":\"2026-07-17T12:03:00Z\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"subagent_spawn\",\"details\":{\"id\":\"sa-unknown\",\"title\":\"Codex child\",\"harness\":\"codex\"}}}\n",
		project,
	)
	child := fmt.Sprintf(
		"{\"type\":\"session\",\"timestamp\":\"2026-07-17T12:04:00Z\",\"cwd\":%q}\n"+
			"{\"type\":\"session_info\",\"timestamp\":\"2026-07-17T12:04:01Z\",\"name\":\"subagent: Live child\"}\n",
		project,
	)
	writeSubagentSession(t, s.sessionsDir, project, "parent-status.jsonl", parent)
	writeSubagentSession(t, s.sessionsDir, project, "child-running.jsonl", child)
	statusDir := filepath.Join(s.agentDir, "session-status")
	if err := os.MkdirAll(statusDir, 0o755); err != nil {
		t.Fatal(err)
	}
	status := fmt.Sprintf(`{"state":"running","updatedAt":%q}`, time.Now().UTC().Format(time.RFC3339))
	if err := os.WriteFile(filepath.Join(statusDir, "child-running.jsonl"), []byte(status), 0o644); err != nil {
		t.Fatal(err)
	}

	items := fetchSubagents(t, s)
	statuses := make(map[string]string)
	for _, item := range items {
		statuses[item.Title] = item.Status
	}
	if statuses["Claude child"] != "error" || statuses["Codex child"] != "unknown" || statuses["Live child"] != "running" {
		t.Fatalf("unexpected statuses: %+v", statuses)
	}
}

func TestHandleApiSubagentsSortsNewestFirstAndCapsResults(t *testing.T) {
	s := newTestServer(t)
	s.now = func() time.Time { return time.Date(2026, 7, 17, 13, 0, 0, 0, time.UTC) }
	project := filepath.Join(t.TempDir(), "many")
	for i := 0; i < 205; i++ {
		timestamp := time.Date(2026, 7, 1, 0, i, 0, 0, time.UTC).Format(time.RFC3339)
		contents := fmt.Sprintf(
			"{\"type\":\"session\",\"timestamp\":%q,\"cwd\":%q}\n{\"type\":\"session_info\",\"timestamp\":%q,\"name\":%q}\n{\"type\":\"message\",\"timestamp\":%q,\"message\":{\"role\":\"assistant\",\"content\":\"done\"}}\n",
			timestamp,
			project,
			timestamp,
			fmt.Sprintf("subagent: Agent %03d", i),
			timestamp,
		)
		writeSubagentSession(t, s.sessionsDir, project, fmt.Sprintf("child-%03d.jsonl", i), contents)
	}

	items := fetchSubagents(t, s)
	if len(items) != subagentResultLimit {
		t.Fatalf("subagents = %d, want %d", len(items), subagentResultLimit)
	}
	if items[0].Title != "Agent 204" || items[len(items)-1].Title != "Agent 005" {
		t.Fatalf("unexpected cap/sort bounds: first=%q last=%q", items[0].Title, items[len(items)-1].Title)
	}
}
