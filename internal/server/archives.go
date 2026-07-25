package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"pican/internal/sessions"
)

const sessionArchivesSchema = `CREATE TABLE IF NOT EXISTS session_archives (
	session_id TEXT PRIMARY KEY,
	archived_at TEXT NOT NULL
)`

func (s *Server) archivedSessionIDs() (map[string]bool, bool) {
	if s.db == nil {
		return nil, false
	}
	rows, err := s.db.Query("SELECT session_id FROM session_archives")
	if err != nil {
		return nil, false
	}
	defer rows.Close()
	ids := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, false
		}
		ids[id] = true
	}
	return ids, rows.Err() == nil
}

func (s *Server) isSessionArchived(sessionID string) bool {
	if s.db == nil {
		return false
	}
	var exists int
	return s.db.QueryRow("SELECT 1 FROM session_archives WHERE session_id = ?", sessionID).Scan(&exists) == nil
}

func markArchivedSummaries(summaries []sessions.SessionSummary, archived map[string]bool) {
	for i := range summaries {
		summaries[i].Archived = archived[summaries[i].ID]
	}
}

func (s *Server) setSessionArchived(sessionID string, archived bool) error {
	if s.db == nil {
		return errors.New("archives are unavailable")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if archived {
		if _, err = tx.Exec(`INSERT INTO session_archives (session_id, archived_at) VALUES (?, ?)
			ON CONFLICT(session_id) DO NOTHING`, sessionID, s.now().Format(time.RFC3339Nano)); err != nil {
			return err
		}
		if _, err = tx.Exec("DELETE FROM session_pins WHERE session_id = ?", sessionID); err != nil {
			return err
		}
	} else if _, err = tx.Exec("DELETE FROM session_archives WHERE session_id = ?", sessionID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) reapOrphanedArchives(all []sessions.SessionSummary) {
	if s.db == nil {
		return
	}
	existing := make(map[string]bool, len(all))
	for _, summary := range all {
		existing[summary.ID] = true
	}
	rows, err := s.db.Query("SELECT session_id FROM session_archives")
	if err != nil {
		return
	}
	var orphans []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil && !existing[id] {
			orphans = append(orphans, id)
		}
	}
	rows.Close()
	for _, id := range orphans {
		_, _ = s.db.Exec("DELETE FROM session_archives WHERE session_id = ?", id)
	}
}

func (s *Server) handleSetArchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		SessionID string `json:"sessionId"`
		Archived  bool   `json:"archived"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	body.SessionID = strings.TrimSpace(body.SessionID)
	if body.SessionID == "" {
		writeJSONError(w, http.StatusBadRequest, "sessionId is required")
		return
	}
	resolved, err := s.cache.Resolve(s.sessionsDir, body.SessionID)
	if resolveOrWriteError(w, err) {
		return
	}
	if body.Archived {
		if s.computeRunningStatus(resolved.Session.ID) {
			writeJSONError(w, http.StatusConflict, "running sessions cannot be archived")
			return
		}
		summary, summaryErr := s.cache.ResolveSummary(s.sessionsDir, resolved.Session.ID)
		if summaryErr == nil && summary.WaitingQuestion != "" {
			writeJSONError(w, http.StatusConflict, "sessions waiting for input cannot be archived")
			return
		}
	}
	if err := s.setSessionArchived(resolved.Session.ID, body.Archived); err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.publishCurationUpdated()
	writeJSON(w, 0, map[string]any{"ok": true, "archived": body.Archived})
}

func (s *Server) publishCurationUpdated() {
	msg, err := formatSSEJSONEvent("curation-updated", map[string]bool{"ok": true})
	if err == nil {
		s.broadcast(globalSessID, msg)
	}
}

// Pinning and archiving share a transaction boundary so the mutually
// exclusive curation states are never visible together.
func setPinnedTx(tx *sql.Tx, sessionID string, pinned bool, now time.Time) error {
	if pinned {
		if _, err := tx.Exec("DELETE FROM session_archives WHERE session_id = ?", sessionID); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO session_pins (session_id, created_at) VALUES (?, ?)
			ON CONFLICT(session_id) DO NOTHING`, sessionID, now.Format(time.RFC3339Nano))
		return err
	}
	_, err := tx.Exec("DELETE FROM session_pins WHERE session_id = ?", sessionID)
	return err
}
