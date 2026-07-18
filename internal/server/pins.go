package server

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"pi-web/internal/sessions"
)

// session_pins records which sessions are pinned to the top of the homepage.
// Like review_comments/annotations, pin state is app-database bookkeeping and
// never touches the append-only session JSONL — a row's mere existence means
// the session is pinned.
const sessionPinsSchema = `CREATE TABLE IF NOT EXISTS session_pins (
	session_id TEXT PRIMARY KEY,
	created_at TEXT NOT NULL
)`

// pinnedSessionIDs returns the set of pinned session ids. The second return
// value is false when pins are unavailable (no database).
func (s *Server) pinnedSessionIDs() (map[string]bool, bool) {
	if s.db == nil {
		return nil, false
	}
	rows, err := s.db.Query("SELECT session_id FROM session_pins")
	if err != nil {
		return nil, false
	}
	defer rows.Close()
	set := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, false
		}
		set[id] = true
	}
	return set, true
}

func (s *Server) setSessionPinned(sessionID string, pinned bool) error {
	if pinned {
		_, err := s.db.Exec(`INSERT INTO session_pins (session_id, created_at) VALUES (?, ?)
			ON CONFLICT(session_id) DO NOTHING`, sessionID, s.now().Format(time.RFC3339))
		return err
	}
	_, err := s.db.Exec("DELETE FROM session_pins WHERE session_id = ?", sessionID)
	return err
}

// reapOrphanedPins deletes pins whose session no longer exists. `all` must be
// the full, unfiltered session list. Cheap enough to run on GET /api/pins
// only — never on the /api/sessions hot path.
func (s *Server) reapOrphanedPins(all []sessions.SessionSummary) {
	if s.db == nil {
		return
	}
	existing := make(map[string]bool, len(all))
	for _, sum := range all {
		existing[sum.ID] = true
	}
	rows, err := s.db.Query("SELECT session_id FROM session_pins")
	if err != nil {
		return
	}
	var orphans []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			continue
		}
		if !existing[id] {
			orphans = append(orphans, id)
		}
	}
	rows.Close()
	for _, id := range orphans {
		_, _ = s.db.Exec("DELETE FROM session_pins WHERE session_id = ?", id)
	}
}

func (s *Server) handleListPins(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.db == nil {
		writeJSON(w, 0, map[string]any{"pins": []string{}})
		return
	}
	if summaries, err := s.loadSummaries(); err == nil {
		s.reapOrphanedPins(summaries)
	}
	pinned, ok := s.pinnedSessionIDs()
	if !ok {
		writeJSON(w, 0, map[string]any{"pins": []string{}})
		return
	}
	ids := make([]string, 0, len(pinned))
	for id := range pinned {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	writeJSON(w, 0, map[string]any{"pins": ids})
}

func (s *Server) handleSetPin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		SessionID string `json:"sessionId"`
		Pinned    bool   `json:"pinned"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	sessionID := strings.TrimSpace(body.SessionID)
	if sessionID == "" {
		writeJSONError(w, http.StatusBadRequest, "sessionId is required")
		return
	}
	if s.db == nil {
		writeJSONError(w, http.StatusInternalServerError, "pins are unavailable")
		return
	}
	if err := s.setSessionPinned(sessionID, body.Pinned); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, 0, map[string]any{"ok": true, "pinned": body.Pinned})
}

// markPinnedSummaries sets Pinned=true in place on every summary whose ID is
// in pinned.
func markPinnedSummaries(summaries []sessions.SessionSummary, pinned map[string]bool) {
	if len(pinned) == 0 {
		return
	}
	for i := range summaries {
		if pinned[summaries[i].ID] {
			summaries[i].Pinned = true
		}
	}
}

// ensurePinnedOnFirstPage guarantees every pinned session in `all` appears in
// `page` when page is the first page (offset 0). Pagination is unaware of pin
// state, so a pinned session with old activity could otherwise be pushed past
// the first page and never surface in the homepage's "Pinned" section without
// loading every page. Missing pinned sessions are prepended, skipping any
// already present in page to avoid duplicates.
func ensurePinnedOnFirstPage(page, all []sessions.SessionSummary, offsetStr string, pinned map[string]bool) []sessions.SessionSummary {
	if len(pinned) == 0 {
		return page
	}
	offset, err := strconv.Atoi(offsetStr)
	if err != nil || offset < 0 {
		offset = 0
	}
	if offset != 0 {
		return page
	}
	present := make(map[string]bool, len(page))
	for _, sum := range page {
		present[sum.ID] = true
	}
	var missing []sessions.SessionSummary
	for _, sum := range all {
		if pinned[sum.ID] && !present[sum.ID] {
			missing = append(missing, sum)
			present[sum.ID] = true
		}
	}
	if len(missing) == 0 {
		return page
	}
	return append(missing, page...)
}
