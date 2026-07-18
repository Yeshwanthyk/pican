package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"pi-web/internal/sessions"
)

const (
	subagentNamePrefix      = "subagent: "
	subagentParentWindow    = 7 * 24 * time.Hour
	subagentMatchWindow     = 5 * time.Minute
	subagentParentFileLimit = 100
	subagentResultLimit     = 200
)

type subagentSummary struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Harness       string `json:"harness"`
	Status        string `json:"status"`
	SpawnedAt     string `json:"spawnedAt"`
	ParentSession string `json:"parentSession"`
	ParentProject string `json:"parentProject"`
	ChildSession  string `json:"childSession"`
	ChildProject  string `json:"childProject"`
	LastActivity  string `json:"lastActivity"`

	spawnCWD      string
	spawnedTime   time.Time
	activityTime  time.Time
	headerTime    time.Time
	resultStatus  string
	parentRunning bool
	childRunning  bool
}

type subagentSessionLine struct {
	Type       string          `json:"type"`
	Timestamp  string          `json:"timestamp"`
	CustomType string          `json:"customType"`
	Details    json.RawMessage `json:"details"`
	Message    *struct {
		ToolName string          `json:"toolName"`
		Details  json.RawMessage `json:"details"`
	} `json:"message"`
}

func parseSubagentTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed
}

func formatSubagentTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func laterSubagentTime(a, b time.Time) time.Time {
	if b.After(a) {
		return b
	}
	return a
}

func scanSubagentParent(path string, parent sessions.SessionSummary, parentRunning bool) []subagentSummary {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()

	records := make([]subagentSummary, 0)
	byID := make(map[string]int)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 256*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if !bytes.Contains(line, []byte("subagent_spawn")) && !bytes.Contains(line, []byte("subagent-result")) {
			continue
		}
		var entry subagentSessionLine
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		if entry.Type == "message" && entry.Message != nil && entry.Message.ToolName == "subagent_spawn" {
			var details struct {
				ID      string `json:"id"`
				Title   string `json:"title"`
				CWD     string `json:"cwd"`
				Harness string `json:"harness"`
			}
			if json.Unmarshal(entry.Message.Details, &details) != nil {
				continue
			}
			spawnedTime := parseSubagentTime(entry.Timestamp)
			records = append(records, subagentSummary{
				ID:            details.ID,
				Title:         details.Title,
				Harness:       details.Harness,
				Status:        "unknown",
				SpawnedAt:     formatSubagentTime(spawnedTime),
				ParentSession: parent.Filename,
				ParentProject: parent.Project,
				LastActivity:  formatSubagentTime(spawnedTime),
				spawnCWD:      details.CWD,
				spawnedTime:   spawnedTime,
				activityTime:  spawnedTime,
				parentRunning: parentRunning,
			})
			if details.ID != "" {
				byID[details.ID] = len(records) - 1
			}
			continue
		}
		if entry.Type == "custom_message" && entry.CustomType == "subagent-result" {
			var details struct {
				ID     string `json:"id"`
				Status string `json:"status"`
			}
			if json.Unmarshal(entry.Details, &details) != nil {
				continue
			}
			index, ok := byID[details.ID]
			if !ok || (details.Status != "done" && details.Status != "error") {
				continue
			}
			resultTime := parseSubagentTime(entry.Timestamp)
			records[index].resultStatus = details.Status
			records[index].Status = details.Status
			records[index].activityTime = laterSubagentTime(records[index].activityTime, resultTime)
			records[index].LastActivity = formatSubagentTime(records[index].activityTime)
		}
	}

	for i := range records {
		if records[i].resultStatus == "" && records[i].parentRunning {
			records[i].Status = "running"
		}
	}
	return records
}

func readSubagentHeaderTime(path string) time.Time {
	file, err := os.Open(path)
	if err != nil {
		return time.Time{}
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 256*1024*1024)
	for scanner.Scan() {
		var entry struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
		}
		if json.Unmarshal(scanner.Bytes(), &entry) == nil && entry.Type == "session" {
			return parseSubagentTime(entry.Timestamp)
		}
	}
	return time.Time{}
}

func subagentTimeGap(parent, child subagentSummary) time.Duration {
	gap := child.headerTime.Sub(parent.spawnedTime)
	if gap < 0 {
		gap = -gap
	}
	return gap
}

func matchSubagentChild(parent, child subagentSummary) bool {
	if parent.Title == "" || parent.Title != child.Title || parent.spawnedTime.IsZero() || child.headerTime.IsZero() {
		return false
	}
	if parent.spawnCWD != "" && parent.spawnCWD != child.ChildProject {
		return false
	}
	// The child session header is written a beat before the parent records the
	// subagent_spawn result, so the child can be slightly earlier than the
	// spawn timestamp. Match on absolute distance within the window rather than
	// requiring the child to come strictly after.
	return subagentTimeGap(parent, child) <= subagentMatchWindow
}

func mergeSubagentSummaries(parents, children []subagentSummary) []subagentSummary {
	merged := make([]subagentSummary, 0, len(parents)+len(children))
	usedChildren := make([]bool, len(children))
	for _, parent := range parents {
		match := -1
		for i := range children {
			if usedChildren[i] || !matchSubagentChild(parent, children[i]) {
				continue
			}
			if match == -1 || subagentTimeGap(parent, children[i]) < subagentTimeGap(parent, children[match]) {
				match = i
			}
		}
		if match >= 0 {
			child := children[match]
			usedChildren[match] = true
			parent.ChildSession = child.ChildSession
			parent.ChildProject = child.ChildProject
			parent.childRunning = child.childRunning
			parent.activityTime = laterSubagentTime(parent.activityTime, child.activityTime)
			parent.LastActivity = formatSubagentTime(parent.activityTime)
			if parent.resultStatus == "" && child.childRunning {
				parent.Status = "running"
			}
		}
		merged = append(merged, parent)
	}
	for i, child := range children {
		if !usedChildren[i] {
			merged = append(merged, child)
		}
	}
	return merged
}

func sortSubagentSummaries(items []subagentSummary) {
	sort.SliceStable(items, func(i, j int) bool {
		if !items[i].activityTime.Equal(items[j].activityTime) {
			return items[i].activityTime.After(items[j].activityTime)
		}
		if items[i].Title != items[j].Title {
			return items[i].Title < items[j].Title
		}
		if items[i].ParentSession != items[j].ParentSession {
			return items[i].ParentSession < items[j].ParentSession
		}
		return items[i].ChildSession < items[j].ChildSession
	})
}

func (s *Server) handleApiSubagents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	summaries, err := s.loadSummaries()
	if err != nil {
		if os.IsNotExist(err) {
			writeJSON(w, 0, map[string]any{"subagents": []subagentSummary{}})
			return
		}
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	sessionUUID := sessionUUIDFromReference(r.URL.Query().Get("session"))

	children := make([]subagentSummary, 0)
	for _, summary := range summaries {
		if !strings.HasPrefix(summary.Name, subagentNamePrefix) {
			continue
		}
		path, ok := s.cache.FindPath(summary.Filename)
		if !ok {
			continue
		}
		activityTime := parseSubagentTime(summary.LastActivity)
		running := s.computeRunningStatus(summary.Filename)
		status := "unknown"
		if running {
			status = "running"
		}
		children = append(children, subagentSummary{
			Title:        strings.TrimPrefix(summary.Name, subagentNamePrefix),
			Status:       status,
			ChildSession: summary.Filename,
			ChildProject: summary.Project,
			LastActivity: formatSubagentTime(activityTime),
			activityTime: activityTime,
			headerTime:   readSubagentHeaderTime(path),
			childRunning: running,
		})
	}

	parents := make([]subagentSummary, 0)
	oldestParentActivity := s.now().Add(-subagentParentWindow)
	parentFiles := 0
	for _, summary := range summaries {
		if parentFiles >= subagentParentFileLimit {
			break
		}
		if sessionUUID != "" && sessionUUIDFromReference(summary.Filename) != sessionUUID {
			continue
		}
		activityTime := parseSubagentTime(summary.LastActivity)
		if activityTime.IsZero() || activityTime.Before(oldestParentActivity) {
			continue
		}
		path, ok := s.cache.FindPath(summary.Filename)
		if !ok {
			continue
		}
		parentFiles++
		parents = append(parents, scanSubagentParent(path, summary, s.computeRunningStatus(summary.Filename))...)
	}

	items := mergeSubagentSummaries(parents, children)
	if sessionUUID != "" {
		// Children that didn't match one of the requested session's spawn
		// records can't be attributed to it — drop them instead of leaking
		// other sessions' subagents into a scoped view.
		scoped := items[:0]
		for _, item := range items {
			if item.ParentSession != "" && sessionUUIDFromReference(item.ParentSession) == sessionUUID {
				scoped = append(scoped, item)
			}
		}
		items = scoped
	}
	sortSubagentSummaries(items)
	if len(items) > subagentResultLimit {
		items = items[:subagentResultLimit]
	}
	writeJSON(w, 0, map[string]any{"subagents": items})
}
