package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pican/internal/workspace"
)

func writeTaskTestFile(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func taskAPIRequest(path, project string) *http.Request {
	return httptest.NewRequest(http.MethodGet, path+"?project="+url.QueryEscape(project), nil)
}

func TestHandleApiTasksRejectsInvalidProject(t *testing.T) {
	s := newTestServer(t)
	for _, project := range []string{"", "relative", filepath.Join(t.TempDir(), "..", "unclean")} {
		w := httptest.NewRecorder()
		s.handleApiTasks(w, taskAPIRequest("/api/tasks", project))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("project %q status = %d, want 400", project, w.Code)
		}
	}
}

func TestHandleApiTasksListsProjectAndSessionStores(t *testing.T) {
	s := newTestServer(t)
	project := t.TempDir()
	tasksDir := filepath.Join(project, ".pi", "tasks")
	writeTaskTestFile(t, filepath.Join(tasksDir, "tasks.json"), `{"nextId":2,"tasks":[{"id":"1","subject":"Project"}]}`)
	writeTaskTestFile(t, filepath.Join(tasksDir, "tasks-session-abc.json"), `{"tasks":[{"id":"2","subject":"Session"}]}`)
	writeTaskTestFile(t, filepath.Join(tasksDir, "broken.json"), `{bad`)
	writeTaskTestFile(t, filepath.Join(tasksDir, "tasks.lock"), `ignored`)

	w := httptest.NewRecorder()
	s.handleApiTasks(w, taskAPIRequest("/api/tasks", project))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Stores []taskStore `json:"stores"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Stores) != 2 {
		t.Fatalf("stores = %d, want 2: %s", len(response.Stores), w.Body.String())
	}
	if response.Stores[0].Scope != "session" || response.Stores[0].SessionID != "session-abc" {
		t.Fatalf("unexpected session store: %+v", response.Stores[0])
	}
	if response.Stores[1].Scope != "project" || len(response.Stores[1].Tasks) != 1 {
		t.Fatalf("unexpected project store: %+v", response.Stores[1])
	}
}

func TestHandleApiTasksFiltersStoresBySession(t *testing.T) {
	s := newTestServer(t)
	project := t.TempDir()
	tasksDir := filepath.Join(project, ".pi", "tasks")
	writeTaskTestFile(t, filepath.Join(tasksDir, "tasks.json"), `{"tasks":[{"id":"1","subject":"Project"}]}`)
	writeTaskTestFile(t, filepath.Join(tasksDir, "tasks-session-abc.json"), `{"tasks":[{"id":"2","subject":"Matching"}]}`)
	writeTaskTestFile(t, filepath.Join(tasksDir, "tasks-other-session.json"), `{"tasks":[{"id":"3","subject":"Unrelated"}]}`)
	writeTaskTestFile(t, filepath.Join(s.globalTasksDir(), "named.json"), `{"tasks":[{"id":"4","subject":"Global"}]}`)

	req := taskAPIRequest("/api/tasks", project)
	query := req.URL.Query()
	query.Set("session", "2026-07-17T12-00-00.000Z_session-abc.jsonl")
	req.URL.RawQuery = query.Encode()
	w := httptest.NewRecorder()
	s.handleApiTasks(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Stores []taskStore `json:"stores"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Stores) != 2 {
		t.Fatalf("stores = %d, want project and matching session: %s", len(response.Stores), w.Body.String())
	}
	if response.Stores[0].Scope != "session" || response.Stores[0].SessionID != "session-abc" {
		t.Fatalf("unexpected session store: %+v", response.Stores[0])
	}
	if response.Stores[1].Scope != "project" {
		t.Fatalf("unexpected project store: %+v", response.Stores[1])
	}
}

func TestHandleApiTaskOutput(t *testing.T) {
	s := newTestServer(t)
	project := t.TempDir()
	writeTaskTestFile(t, filepath.Join(project, ".pi", "tasks", "tasks.json"), `{"tasks":[]}`)
	writeTaskTestFile(t, filepath.Join(project, ".pi", "tasks", "output", "task-abc-1.txt"), "task output\n")

	for _, test := range []struct {
		name   string
		taskID string
		status int
	}{
		{name: "success", taskID: "abc-1", status: http.StatusOK},
		{name: "missing", taskID: "missing", status: http.StatusNotFound},
		{name: "invalid", taskID: "../secret", status: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := taskAPIRequest("/api/tasks/output", project)
			query := req.URL.Query()
			query.Set("taskId", test.taskID)
			req.URL.RawQuery = query.Encode()
			w := httptest.NewRecorder()
			s.handleApiTaskOutput(w, req)
			if w.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", w.Code, test.status, w.Body.String())
			}
			if test.status == http.StatusOK {
				if w.Body.String() != "task output\n" || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") {
					t.Fatalf("unexpected response: content-type=%q body=%q", w.Header().Get("Content-Type"), w.Body.String())
				}
			}
		})
	}
}

func TestHostedTasksRejectStoreAndOutputSymlinkEscapes(t *testing.T) {
	root := t.TempDir()
	workspaceRoot := filepath.Join(root, "workspace")
	project := filepath.Join(workspaceRoot, "project")
	outside := filepath.Join(root, "outside")
	for _, path := range []string{filepath.Join(project, ".pi"), outside} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeTaskTestFile(t, filepath.Join(outside, "tasks.json"), `{"tasks":[{"id":"secret"}]}`)
	if err := os.Symlink(outside, filepath.Join(project, ".pi", "tasks")); err != nil {
		t.Fatal(err)
	}
	resolver, err := workspace.New(workspaceRoot)
	if err != nil {
		t.Fatal(err)
	}
	s := newTestServer(t)
	s.workspace = resolver
	s.workspaceRoot = resolver.Root()
	s.hosted = true

	stores := httptest.NewRecorder()
	s.handleApiTasks(stores, taskAPIRequest("/api/tasks", project))
	if stores.Code != http.StatusBadRequest {
		t.Fatalf("symlinked store status = %d, want 400: %s", stores.Code, stores.Body.String())
	}

	if err := os.Remove(filepath.Join(project, ".pi", "tasks")); err != nil {
		t.Fatal(err)
	}
	writeTaskTestFile(t, filepath.Join(project, ".pi", "tasks", "tasks.json"), `{"tasks":[]}`)
	outputOutside := filepath.Join(outside, "output")
	writeTaskTestFile(t, filepath.Join(outputOutside, "task-secret.txt"), "secret")
	if err := os.Symlink(outputOutside, filepath.Join(project, ".pi", "tasks", "output")); err != nil {
		t.Fatal(err)
	}
	output := httptest.NewRecorder()
	req := taskAPIRequest("/api/tasks/output", project)
	query := req.URL.Query()
	query.Set("taskId", "secret")
	req.URL.RawQuery = query.Encode()
	s.handleApiTaskOutput(output, req)
	if output.Code != http.StatusBadRequest {
		t.Fatalf("symlinked output status = %d, want 400: %s", output.Code, output.Body.String())
	}
}
