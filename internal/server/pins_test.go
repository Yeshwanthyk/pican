package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"pican/internal/sessions"

	_ "modernc.org/sqlite"
)

func newPinsDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if _, err := db.Exec(sessionPinsSchema); err != nil {
		t.Fatalf("create session_pins: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func newPinsServer(t *testing.T) *Server {
	t.Helper()
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatal(err)
	}
	return &Server{
		sessionsDir: sessionsDir,
		cache:       sessions.NewCache(),
		db:          newPinsDB(t),
		now:         func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
	}
}

// TestHandleSetPin_ToggleRoundTrip exercises pinning and unpinning the same
// session through the POST /api/pins handler.
func TestHandleSetPin_ToggleRoundTrip(t *testing.T) {
	s := newPinsServer(t)
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/pins", strings.NewReader(body))
		w := httptest.NewRecorder()
		s.handleSetPin(w, req)
		return w
	}

	w := post(`{"sessionId":"a.jsonl","pinned":true}`)
	if w.Code != http.StatusOK {
		t.Fatalf("pin: status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		OK     bool `json:"ok"`
		Pinned bool `json:"pinned"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || !resp.Pinned {
		t.Fatalf("pin response = %+v, want ok=true pinned=true", resp)
	}
	pinned, ok := s.pinnedSessionIDs()
	if !ok || !pinned["a.jsonl"] {
		t.Fatalf("expected a.jsonl pinned after pin request, got %v (ok=%v)", pinned, ok)
	}

	w = post(`{"sessionId":"a.jsonl","pinned":false}`)
	if w.Code != http.StatusOK {
		t.Fatalf("unpin: status = %d, body = %s", w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.OK || resp.Pinned {
		t.Fatalf("unpin response = %+v, want ok=true pinned=false", resp)
	}
	pinned, _ = s.pinnedSessionIDs()
	if pinned["a.jsonl"] {
		t.Fatal("expected a.jsonl unpinned after unpin request")
	}
}

func TestHandleSetPin_Validation(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		body       string
		wantStatus int
	}{
		{"missing sessionId", http.MethodPost, `{"pinned":true}`, http.StatusBadRequest},
		{"blank sessionId", http.MethodPost, `{"sessionId":"   ","pinned":true}`, http.StatusBadRequest},
		{"invalid json", http.MethodPost, `{`, http.StatusBadRequest},
		{"wrong method", http.MethodGet, ``, http.StatusMethodNotAllowed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newPinsServer(t)
			req := httptest.NewRequest(tt.method, "/api/pins", strings.NewReader(tt.body))
			w := httptest.NewRecorder()
			s.handleSetPin(w, req)
			if w.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s", w.Code, tt.wantStatus, w.Body.String())
			}
		})
	}
}

// TestHandleApiSessions_PinnedFlag verifies /api/sessions marks the pinned
// flag on each session summary from the session_pins table.
func TestHandleApiSessions_PinnedFlag(t *testing.T) {
	s := newPinsServer(t)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), "a.jsonl", "/home/user/project")
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), "b.jsonl", "/home/user/project")

	if err := s.setSessionPinned("a.jsonl", true); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions", nil)
	w := httptest.NewRecorder()
	s.handleApiSessions(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Sessions []sessions.SessionSummary `json:"sessions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	pinned := map[string]bool{}
	for _, sum := range resp.Sessions {
		pinned[sum.ID] = sum.Pinned
	}
	if !pinned["a.jsonl"] {
		t.Fatal("a.jsonl should be marked pinned")
	}
	if pinned["b.jsonl"] {
		t.Fatal("b.jsonl should not be pinned")
	}
}

// TestHandleApiSessions_PinnedSurvivesPagination verifies a pinned session
// that would otherwise be paginated off the first page is prepended into it.
func TestHandleApiSessions_PinnedSurvivesPagination(t *testing.T) {
	s := newPinsServer(t)
	for i := 0; i < 5; i++ {
		name := "s" + strconv.Itoa(i) + ".jsonl"
		writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), name, "/home/user/project")
	}
	// All 5 sessions share the same activity timestamp, so ties break by
	// directory-read (alphabetical) order: s0, s1, s2, s3, s4. Pin the last
	// one — with limit=2 it would never reach the first page otherwise.
	if err := s.setSessionPinned("s4.jsonl", true); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/sessions?limit=2", nil)
	w := httptest.NewRecorder()
	s.handleApiSessions(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Sessions []sessions.SessionSummary `json:"sessions"`
		Total    int                       `json:"total"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Total != 5 {
		t.Fatalf("total = %d, want 5", resp.Total)
	}
	found := false
	for _, sum := range resp.Sessions {
		if sum.ID == "s4.jsonl" {
			found = true
			if !sum.Pinned {
				t.Fatal("s4.jsonl should be marked pinned in the first page")
			}
		}
	}
	if !found {
		t.Fatal("pinned session s4.jsonl should survive pagination onto the first page")
	}

	// A later page must not also carry the pinned session (no duplicates).
	req2 := httptest.NewRequest(http.MethodGet, "/api/sessions?limit=2&offset=2", nil)
	w2 := httptest.NewRecorder()
	s.handleApiSessions(w2, req2)
	var resp2 struct {
		Sessions []sessions.SessionSummary `json:"sessions"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatal(err)
	}
	for _, sum := range resp2.Sessions {
		if sum.ID == "s4.jsonl" {
			t.Fatal("pinned session should not be duplicated onto a later page")
		}
	}
}

// TestHandleListPins_ReapsOrphanedPins verifies GET /api/pins deletes pins for
// sessions that no longer exist on disk, without touching pins for sessions
// that do.
func TestHandleListPins_ReapsOrphanedPins(t *testing.T) {
	s := newPinsServer(t)
	writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), "keep.jsonl", "/home/user/project")

	if err := s.setSessionPinned("keep.jsonl", true); err != nil {
		t.Fatal(err)
	}
	if err := s.setSessionPinned("gone.jsonl", true); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/pins", nil)
	w := httptest.NewRecorder()
	s.handleListPins(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Pins []string `json:"pins"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Pins) != 1 || resp.Pins[0] != "keep.jsonl" {
		t.Fatalf("pins = %v, want [keep.jsonl]", resp.Pins)
	}

	pinned, _ := s.pinnedSessionIDs()
	if pinned["gone.jsonl"] {
		t.Fatal("orphaned pin for gone.jsonl should have been reaped")
	}
	if !pinned["keep.jsonl"] {
		t.Fatal("pin for keep.jsonl should survive reaping")
	}
}

func TestHandleListPins_PreservesPinOrder(t *testing.T) {
	s := newPinsServer(t)
	for _, id := range []string{"alpha.jsonl", "beta.jsonl", "gamma.jsonl"} {
		writeSessionWithCWD(t, filepath.Join(s.sessionsDir, "sub"), id, "/home/user/project")
	}
	// newPinsServer intentionally returns one fixed timestamp. The rowid tie
	// breaker must still retain the order in which these pins were created.
	for _, id := range []string{"beta.jsonl", "alpha.jsonl", "gamma.jsonl"} {
		if err := s.setSessionPinned(id, true); err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/pins", nil)
	w := httptest.NewRecorder()
	s.handleListPins(w, req)
	var resp struct {
		Pins []string `json:"pins"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	want := []string{"beta.jsonl", "alpha.jsonl", "gamma.jsonl"}
	if strings.Join(resp.Pins, ",") != strings.Join(want, ",") {
		t.Fatalf("pins = %v, want %v", resp.Pins, want)
	}
}
