package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"pican/internal/workers"
)

type extensionSenderStub struct {
	*fakeSender
	requests []json.RawMessage
	respond  func(string, string, workers.ExtensionUIResponse) error
}

func (s *extensionSenderStub) PendingExtensionUI(string) ([]json.RawMessage, bool) {
	return s.requests, true
}

func (s *extensionSenderStub) RespondExtensionUI(sessionID, id string, response workers.ExtensionUIResponse) error {
	return s.respond(sessionID, id, response)
}

func TestExtensionUIRespondAndPendingHandlers(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	confirmed := false
	stub := &extensionSenderStub{
		fakeSender: &fakeSender{},
		requests:   []json.RawMessage{json.RawMessage(`{"id":"ui-1","method":"confirm"}`)},
		respond: func(sessionID, id string, response workers.ExtensionUIResponse) error {
			if sessionID != "session.jsonl" || id != "ui-1" || response.Confirmed == nil || *response.Confirmed {
				t.Fatalf("response = %q %q %#v", sessionID, id, response)
			}
			return nil
		},
	}
	s := &Server{sessionsDir: root, chatSender: stub}

	pendingReq := httptest.NewRequest(http.MethodGet, "/api/extension-ui/pending?session=session.jsonl", nil)
	pendingRec := httptest.NewRecorder()
	s.handlePendingExtensionUI(pendingRec, pendingReq)
	if pendingRec.Code != http.StatusOK || !bytes.Contains(pendingRec.Body.Bytes(), []byte(`"ui-1"`)) {
		t.Fatalf("pending = %d %s", pendingRec.Code, pendingRec.Body.String())
	}

	body, _ := json.Marshal(map[string]any{"session": "session.jsonl", "id": "ui-1", "confirmed": confirmed})
	respondReq := httptest.NewRequest(http.MethodPost, "/api/extension-ui/respond", bytes.NewReader(body))
	respondRec := httptest.NewRecorder()
	s.handleRespondExtensionUI(respondRec, respondReq)
	if respondRec.Code != http.StatusOK {
		t.Fatalf("respond = %d %s", respondRec.Code, respondRec.Body.String())
	}
}

func TestExtensionUIRespondUnknownReturnsNotFound(t *testing.T) {
	root := t.TempDir()
	writeSessionFile(t, root, "--tmp--project--", "session.jsonl")
	stub := &extensionSenderStub{
		fakeSender: &fakeSender{},
		respond: func(string, string, workers.ExtensionUIResponse) error {
			return workers.ErrExtensionUIRequestNotFound
		},
	}
	s := &Server{sessionsDir: root, chatSender: stub}
	body := bytes.NewBufferString(`{"session":"session.jsonl","id":"missing"}`)
	rec := httptest.NewRecorder()
	s.handleRespondExtensionUI(rec, httptest.NewRequest(http.MethodPost, "/api/extension-ui/respond", body))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
}
