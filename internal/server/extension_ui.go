package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"pican/internal/sessions"
	"pican/internal/workers"
)

type extensionUIChatSender interface {
	PendingExtensionUI(sessionID string) ([]json.RawMessage, bool)
	RespondExtensionUI(sessionID, id string, response workers.ExtensionUIResponse) error
}

func (s *Server) handlePendingExtensionUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	resolved, err := sessions.ResolveByID(s.sessionsDir, r.URL.Query().Get("session"))
	if resolveOrWriteError(w, err) {
		return
	}
	extensionSender, ok := s.chatSender.(extensionUIChatSender)
	if !ok {
		writeJSON(w, 0, map[string]any{"requests": []json.RawMessage{}})
		return
	}
	requests, _ := extensionSender.PendingExtensionUI(resolved.Session.ID)
	if requests == nil {
		requests = []json.RawMessage{}
	}
	writeJSON(w, 0, map[string]any{"requests": requests})
}

func (s *Server) handleRespondExtensionUI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		Session   string  `json:"session"`
		ID        string  `json:"id"`
		Confirmed *bool   `json:"confirmed"`
		Value     *string `json:"value"`
		Cancelled *bool   `json:"cancelled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Session == "" || body.ID == "" {
		writeJSONError(w, http.StatusBadRequest, "session and id are required")
		return
	}
	resolved, err := sessions.ResolveByID(s.sessionsDir, body.Session)
	if resolveOrWriteError(w, err) {
		return
	}
	extensionSender, ok := s.chatSender.(extensionUIChatSender)
	if !ok {
		writeJSONError(w, http.StatusNotFound, "extension UI request not found")
		return
	}
	err = extensionSender.RespondExtensionUI(resolved.Session.ID, body.ID, workers.ExtensionUIResponse{
		Confirmed: body.Confirmed,
		Value:     body.Value,
		Cancelled: body.Cancelled,
	})
	if errors.Is(err, workers.ErrExtensionUIRequestNotFound) {
		writeJSONError(w, http.StatusNotFound, "extension UI request not found")
		return
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	payload, _ := json.Marshal(map[string]string{"id": body.ID})
	s.BroadcastExtensionUI(resolved.Session.ID, "extension-ui-resolved", payload)
	writeJSON(w, 0, map[string]any{"ok": true})
}
