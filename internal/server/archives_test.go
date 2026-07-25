package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pican/internal/sessions"
)

func postArchive(t *testing.T, s *Server, sessionID string, archived bool) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"sessionId": sessionID, "archived": archived})
	req := httptest.NewRequest(http.MethodPost, "/api/archives", strings.NewReader(string(body)))
	w := httptest.NewRecorder()
	s.handleSetArchive(w, req)
	return w
}

func TestArchiveRoundTripAndViewPaging(t *testing.T) {
	s := newTestServer(t)
	project := t.TempDir()
	for _, id := range []string{"a.jsonl", "b.jsonl", "c.jsonl"} {
		writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), id, project)
	}

	if w := postArchive(t, s, "a.jsonl", true); w.Code != http.StatusOK {
		t.Fatalf("archive status = %d, body = %s", w.Code, w.Body.String())
	}
	if count, total := getSessions(t, s, "/api/sessions?view=all"); count != 2 || total != 2 {
		t.Fatalf("all after archive = %d/%d, want 2/2", count, total)
	}
	if count, total := getSessions(t, s, "/api/sessions?view=archived&limit=1"); count != 1 || total != 1 {
		t.Fatalf("archived page = %d/%d, want 1/1", count, total)
	}
	if count, total := getSessions(t, s, "/api/sessions?project="+project); count != 2 || total != 2 {
		t.Fatalf("project after archive = %d/%d, want 2/2", count, total)
	}

	if w := postArchive(t, s, "a.jsonl", false); w.Code != http.StatusOK {
		t.Fatalf("restore status = %d, body = %s", w.Code, w.Body.String())
	}
	if count, total := getSessions(t, s, "/api/sessions?view=all"); count != 3 || total != 3 {
		t.Fatalf("all after restore = %d/%d, want 3/3", count, total)
	}
}

func TestPinArchiveExclusivity(t *testing.T) {
	s := newTestServer(t)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), "a.jsonl", t.TempDir())

	if err := s.setSessionPinned("a.jsonl", true); err != nil {
		t.Fatal(err)
	}
	if err := s.setSessionArchived("a.jsonl", true); err != nil {
		t.Fatal(err)
	}
	pins, _ := s.pinnedSessionIDs()
	if pins["a.jsonl"] || !s.isSessionArchived("a.jsonl") {
		t.Fatalf("archive must atomically unpin: pins=%v archived=%v", pins, s.isSessionArchived("a.jsonl"))
	}

	if err := s.setSessionPinned("a.jsonl", true); err != nil {
		t.Fatal(err)
	}
	pins, _ = s.pinnedSessionIDs()
	if !pins["a.jsonl"] || s.isSessionArchived("a.jsonl") {
		t.Fatalf("pin must atomically restore: pins=%v archived=%v", pins, s.isSessionArchived("a.jsonl"))
	}
}

func TestArchiveRejectsMissingRunningAndWaitingSessions(t *testing.T) {
	s := newTestServer(t, func() time.Time { return time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC) })
	project := t.TempDir()
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), "running.jsonl", project)
	waitingPath := writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), "waiting.jsonl", project)
	waitingContent := `{"type":"session","version":3,"id":"sid","timestamp":"2026-05-08T10:00:00Z"}` + "\n" +
		`{"type":"message","id":"assistant","timestamp":"2026-05-08T10:01:00Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"q1","name":"ask_user_question","arguments":{"questions":[{"question":"Ship this change?","options":[{"label":"Ship"},{"label":"Hold"}]}]}}]}}` + "\n"
	if err := os.WriteFile(waitingPath, []byte(waitingContent), 0644); err != nil {
		t.Fatal(err)
	}
	waiting, err := s.cache.ResolveSummary(s.sessionsDir, "waiting.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if waiting.WaitingQuestion == "" {
		t.Fatalf("waiting fixture did not parse as waiting: %+v", waiting)
	}
	s.fileModMu.Lock()
	s.fileMod["running.jsonl"] = s.now()
	s.fileModMu.Unlock()
	if w := postArchive(t, s, "running.jsonl", true); w.Code != http.StatusConflict {
		t.Fatalf("running archive status = %d, want 409: %s", w.Code, w.Body.String())
	}
	if w := postArchive(t, s, "waiting.jsonl", true); w.Code != http.StatusConflict {
		t.Fatalf("waiting archive status = %d, want 409: %s", w.Code, w.Body.String())
	}

	if w := postArchive(t, s, "missing.jsonl", true); w.Code != http.StatusNotFound {
		t.Fatalf("missing archive status = %d, want 404: %s", w.Code, w.Body.String())
	}
}

func TestApiSessionIncludesArchivedFlag(t *testing.T) {
	s := newTestServer(t)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), "a.jsonl", t.TempDir())
	if err := s.setSessionArchived("a.jsonl", true); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=a.jsonl", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)
	var payload struct {
		Archived bool `json:"archived"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Archived {
		t.Fatal("/api/session archived = false, want true")
	}
}

func TestReapOrphanedArchives(t *testing.T) {
	s := newTestServer(t)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), "keep.jsonl", t.TempDir())
	if err := s.setSessionArchived("keep.jsonl", true); err != nil {
		t.Fatal(err)
	}
	if err := s.setSessionArchived("gone.jsonl", true); err != nil {
		t.Fatal(err)
	}
	all, err := s.loadSummaries()
	if err != nil {
		t.Fatal(err)
	}
	s.reapOrphanedArchives(all)
	ids, _ := s.archivedSessionIDs()
	if !ids["keep.jsonl"] || ids["gone.jsonl"] {
		t.Fatalf("archives after reap = %v", ids)
	}
}

func TestHomeIncludesNowPinsAndSixPerTrackedProject(t *testing.T) {
	s := newTestServer(t)
	tracked := t.TempDir()
	untracked := t.TempDir()
	if err := s.trackProject(tracked); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "tracked"), string(rune('a'+i))+".jsonl", tracked)
	}
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "other"), "pinned.jsonl", untracked)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "other"), "running.jsonl", untracked)
	if err := s.setSessionPinned("pinned.jsonl", true); err != nil {
		t.Fatal(err)
	}
	s.lastKnownMu.Lock()
	s.lastKnown["running.jsonl"] = struct{}{}
	s.lastKnownMu.Unlock()

	req := httptest.NewRequest(http.MethodGet, "/api/sessions?view=home&limit=1", nil)
	w := httptest.NewRecorder()
	s.handleApiSessions(w, req)
	var payload struct {
		Sessions []sessions.SessionSummary `json:"sessions"`
		Total    int                       `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Sessions) != 8 || payload.Total != 8 {
		t.Fatalf("home size = %d/%d, want 8/8", len(payload.Sessions), payload.Total)
	}
	if payload.Sessions[0].ID != "running.jsonl" {
		t.Fatalf("home first = %q, want running Now session", payload.Sessions[0].ID)
	}
	if payload.Sessions[1].ID != "pinned.jsonl" || !payload.Sessions[1].Pinned {
		t.Fatalf("home second = %+v, want pinned session", payload.Sessions[1])
	}
	trackedCount := 0
	for _, summary := range payload.Sessions {
		if summary.Project == tracked {
			trackedCount++
		}
	}
	if trackedCount != 6 {
		t.Fatalf("tracked preview count = %d, want 6", trackedCount)
	}
}
