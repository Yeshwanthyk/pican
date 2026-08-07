package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	sseHeartbeatInterval  = 15 * time.Second
	sseHeartbeatFreshness = "transport-only"
)

type sseHeartbeat struct {
	Timestamp time.Time `json:"timestamp"`
	Freshness string    `json:"freshness"`
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()
	s.handleEventsWithHeartbeat(w, r, ticker.C)
}

// handleEventsWithHeartbeat owns one bounded mailbox and one caller-owned
// heartbeat source for the lifetime of the stream. Tests pass a manually
// driven channel so heartbeat behavior does not depend on wall-clock sleeps.
func (s *Server) handleEventsWithHeartbeat(w http.ResponseWriter, r *http.Request, heartbeat <-chan time.Time) {
	sessID := r.URL.Query().Get("id")
	if sessID == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}

	if _, ok := w.(http.Flusher); !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	client := s.addClient(sessID)
	defer s.removeClient(client)

	if err := writeSSEFrame(w, ":ok"); err != nil {
		return
	}

	if sessID == globalSessID {
		if err := s.writeStatusSnapshot(w); err != nil {
			return
		}
	} else if s.chatSender != nil {
		status := s.chatSender.Status(sessID)
		if status.State == "error" {
			data, _ := json.Marshal(status)
			if err := writeSSEFrame(w, fmt.Sprintf("event: worker-status\ndata: %s", data)); err != nil {
				return
			}
		}
	}

	for {
		select {
		case token, open := <-client.ch:
			if !open {
				return
			}
			msg := client.resolveToken(token)
			if !strings.HasPrefix(msg, "event: ") {
				msg = "data: " + msg
			}
			if err := writeSSEFrame(w, msg); err != nil {
				return
			}
		case tick, open := <-heartbeat:
			if !open {
				heartbeat = nil
				continue
			}
			msg, err := formatSSEJSONEvent("heartbeat", sseHeartbeat{
				Timestamp: tick.UTC(),
				Freshness: sseHeartbeatFreshness,
			})
			if err != nil {
				return
			}
			if err := writeSSEFrame(w, msg); err != nil {
				return
			}
			recordSSEHeartbeat()
		case <-r.Context().Done():
			return
		}
	}
}

// writeSSEFrame writes and flushes exactly one SSE frame. A write or flush
// failure is terminal for the connection; continuing would only retain a dead
// client and consume mailbox capacity.
func writeSSEFrame(w http.ResponseWriter, frame string) error {
	if _, err := fmt.Fprint(w, frame+"\n\n"); err != nil {
		recordSSEWriteError()
		return err
	}
	if err := http.NewResponseController(w).Flush(); err != nil {
		recordSSEFlushError()
		return err
	}
	return nil
}

// writeStatusSnapshot emits a single SSE event listing every session id that
// is currently broadcast as running. Sorted for deterministic test output.
func (s *Server) writeStatusSnapshot(w http.ResponseWriter) error {
	s.lastKnownMu.Lock()
	ids := make([]string, 0, len(s.lastKnown))
	for id := range s.lastKnown {
		ids = append(ids, id)
	}
	s.lastKnownMu.Unlock()
	sort.Strings(ids)

	var sb strings.Builder
	sb.WriteString(`{"running":[`)
	for i, id := range ids {
		if i > 0 {
			sb.WriteByte(',')
		}
		idJSON, _ := json.Marshal(id)
		sb.Write(idJSON)
	}
	sb.WriteString(`],"statuses":{`)
	for i, id := range ids {
		if i > 0 {
			sb.WriteByte(',')
		}
		idJSON, _ := json.Marshal(id)
		sb.Write(idJSON)
		sb.WriteByte(':')
		data, _ := json.Marshal(s.runningStatusPayload(id, true))
		sb.Write(data)
	}
	sb.WriteString("}}")

	return writeSSEFrame(w, "event: status-snapshot\ndata: "+sb.String())
}
