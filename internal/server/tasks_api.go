package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"pican/internal/agentdir"
)

var taskIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

type taskStore struct {
	Path      string            `json:"path"`
	Scope     string            `json:"scope"`
	SessionID string            `json:"sessionId"`
	Tasks     []json.RawMessage `json:"tasks"`
}

func (s *Server) globalTasksDir() string {
	if filepath.Clean(s.agentDir) == filepath.Clean(agentdir.Path()) {
		home, _ := os.UserHomeDir()
		if home != "" {
			return filepath.Join(home, ".pi", "tasks")
		}
	}
	return filepath.Join(s.agentDir, "tasks")
}

func (s *Server) validateTasksProject(project string) (string, error) {
	if project == "" || !filepath.IsAbs(project) || filepath.Clean(project) != project {
		return "", errors.New("project must be an absolute cleaned path")
	}
	var err error
	project, err = s.resolveWorkspacePath(project)
	if err != nil {
		return "", err
	}
	summaries, err := s.loadSummaries()
	if err != nil {
		return "", err
	}
	for _, summary := range summaries {
		if summary.Project == project {
			return project, nil
		}
	}
	taskDir, taskDirErr := s.resolveWorkspaceLeaf(filepath.Join(project, ".pi", "tasks"))
	if taskDirErr != nil {
		return "", taskDirErr
	}
	info, err := os.Stat(taskDir)
	if err == nil && info.IsDir() {
		return project, nil
	}
	return "", errors.New("unknown project")
}

func readTaskStores(dir, defaultScope string) ([]taskStore, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []taskStore{}, nil
	}
	if err != nil {
		return nil, err
	}
	stores := make([]taskStore, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var payload struct {
			Tasks []json.RawMessage `json:"tasks"`
		}
		if json.Unmarshal(data, &payload) != nil || payload.Tasks == nil {
			continue
		}
		scope := defaultScope
		sessionID := ""
		if defaultScope != "global" && strings.HasPrefix(entry.Name(), "tasks-") {
			sessionID = strings.TrimSuffix(strings.TrimPrefix(entry.Name(), "tasks-"), ".json")
			if sessionID != "" {
				scope = "session"
			}
		}
		stores = append(stores, taskStore{
			Path:      path,
			Scope:     scope,
			SessionID: sessionID,
			Tasks:     payload.Tasks,
		})
	}
	sort.Slice(stores, func(i, j int) bool { return stores[i].Path < stores[j].Path })
	return stores, nil
}

func (s *Server) handleApiTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	project, err := s.validateTasksProject(r.URL.Query().Get("project"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.watchTasksProject(project)
	taskDir, err := s.resolveWorkspaceLeaf(filepath.Join(project, ".pi", "tasks"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	projectStores, err := readTaskStores(taskDir, "project")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	sessionID := sessionUUIDFromReference(r.URL.Query().Get("session"))
	if sessionID != "" {
		filteredStores := make([]taskStore, 0, 2)
		for _, store := range projectStores {
			if (store.Scope == "project" && filepath.Base(store.Path) == "tasks.json") ||
				(store.Scope == "session" && store.SessionID == sessionID) {
				filteredStores = append(filteredStores, store)
			}
		}
		writeJSON(w, 0, map[string]any{"stores": filteredStores})
		return
	}
	if s.workspace != nil {
		writeJSON(w, 0, map[string]any{"stores": projectStores})
		return
	}
	globalStores, err := readTaskStores(s.globalTasksDir(), "global")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, 0, map[string]any{"stores": append(projectStores, globalStores...)})
}

func (s *Server) handleApiTaskOutput(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	project, err := s.validateTasksProject(r.URL.Query().Get("project"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	taskID := r.URL.Query().Get("taskId")
	if !taskIDPattern.MatchString(taskID) {
		writeJSONError(w, http.StatusBadRequest, "invalid taskId")
		return
	}
	outputPath, err := s.resolveWorkspaceLeaf(filepath.Join(project, ".pi", "tasks", "output", "task-"+taskID+".txt"))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	data, err := os.ReadFile(outputPath)
	if os.IsNotExist(err) {
		writeJSONError(w, http.StatusNotFound, "task output not found")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write(data)
}
