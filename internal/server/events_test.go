package server

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncRecorder wraps httptest.ResponseRecorder so the handler goroutine's
// writes and the test goroutine's reads of the body do not race under -race.
type syncRecorder struct {
	*httptest.ResponseRecorder
	mu  sync.Mutex
	buf bytes.Buffer
}

func newSyncRecorder() *syncRecorder {
	return &syncRecorder{ResponseRecorder: httptest.NewRecorder()}
}

func (s *syncRecorder) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncRecorder) body() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

type failingSSEWriter struct {
	header   http.Header
	writeErr error
	flushErr error
}

func (w *failingSSEWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (*failingSSEWriter) WriteHeader(int) {}

func (w *failingSSEWriter) Write(p []byte) (int, error) {
	if w.writeErr != nil {
		return 0, w.writeErr
	}
	return len(p), nil
}

func (*failingSSEWriter) Flush() {}

func (w *failingSSEWriter) FlushError() error { return w.flushErr }

func waitFor(t *testing.T, rec *syncRecorder, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(rec.body(), want) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %q in body:\n%s", want, rec.body())
}

func TestHandleEventsSendsStatusSnapshotForAllSubscribers(t *testing.T) {
	s := &Server{
		sessionsDir: t.TempDir(),
		chatSender:  &fakeSender{},
		clients:     make([]*sseClient, 0),
		lastKnown:   map[string]struct{}{"a.jsonl": {}, "b.jsonl": {}},
	}

	req := httptest.NewRequest(http.MethodGet, "/events?id=__all__", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	w := newSyncRecorder()

	done := make(chan struct{})
	go func() {
		s.handleEvents(w, req)
		close(done)
	}()

	// Wait for the snapshot to be written, then close.
	waitFor(t, w, "event: status-snapshot")
	cancel()
	<-done

	body := w.body()
	if !strings.HasPrefix(body, ":ok\n\nevent: status-snapshot\ndata: ") {
		t.Fatalf("initial comment/status snapshot order changed:\n%s", body)
	}
	if !strings.Contains(body, `"a.jsonl"`) || !strings.Contains(body, `"b.jsonl"`) {
		t.Fatalf("snapshot did not include both ids:\n%s", body)
	}
}

func TestHandleEventsEmitsNamedHeartbeatFromDrivenCadence(t *testing.T) {
	s := &Server{
		sessionsDir: t.TempDir(),
		chatSender:  &fakeSender{},
		clients:     make([]*sseClient, 0),
		lastKnown:   make(map[string]struct{}),
	}

	req := httptest.NewRequest(http.MethodGet, "/events?id=__all__", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	w := newSyncRecorder()
	ticks := make(chan time.Time, 1)

	done := make(chan struct{})
	go func() {
		s.handleEventsWithHeartbeat(w, req, ticks)
		close(done)
	}()

	waitFor(t, w, "event: status-snapshot\ndata: {\"running\":[],\"statuses\":{}}")
	before := sseProcessMetrics.heartbeats.Load()
	ticks <- time.Date(2026, 5, 8, 11, 0, 0, 123456789, time.FixedZone("test", 2*60*60))
	waitFor(t, w, "event: heartbeat")
	cancel()
	<-done

	body := w.body()
	want := "event: heartbeat\ndata: {\"timestamp\":\"2026-05-08T09:00:00.123456789Z\",\"freshness\":\"transport-only\"}\n\n"
	if !strings.Contains(body, want) {
		t.Fatalf("heartbeat frame missing or malformed; want %q in:\n%s", want, body)
	}
	if got := sseProcessMetrics.heartbeats.Load(); got != before+1 {
		t.Fatalf("heartbeat metric = %d, want %d", got, before+1)
	}
}

func TestHandleEventsDisconnectRemovesClient(t *testing.T) {
	s := &Server{
		sessionsDir: t.TempDir(),
		chatSender:  &fakeSender{},
		clients:     make([]*sseClient, 0),
		lastKnown:   make(map[string]struct{}),
	}

	req := httptest.NewRequest(http.MethodGet, "/events?id=session.jsonl", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	w := newSyncRecorder()
	done := make(chan struct{})
	go func() {
		s.handleEventsWithHeartbeat(w, req, nil)
		close(done)
	}()

	waitFor(t, w, ":ok\n\n")
	s.clientsMu.RLock()
	connected := len(s.clients)
	s.clientsMu.RUnlock()
	if connected != 1 {
		t.Fatalf("connected clients = %d, want 1", connected)
	}

	cancel()
	<-done
	s.clientsMu.RLock()
	connected = len(s.clients)
	s.clientsMu.RUnlock()
	if connected != 0 {
		t.Fatalf("clients after disconnect = %d, want 0", connected)
	}
}

func TestHandleEventsWriteErrorTerminatesAndCleansUp(t *testing.T) {
	s := &Server{clients: make([]*sseClient, 0), lastKnown: make(map[string]struct{})}
	req := httptest.NewRequest(http.MethodGet, "/events?id=session.jsonl", nil)
	before := sseProcessMetrics.writeErrs.Load()

	w := &failingSSEWriter{writeErr: errors.New("client disconnected")}
	s.handleEventsWithHeartbeat(w, req, nil)

	if got := len(s.clients); got != 0 {
		t.Fatalf("clients after write error = %d, want 0", got)
	}
	if got := sseProcessMetrics.writeErrs.Load(); got != before+1 {
		t.Fatalf("write error metric = %d, want %d", got, before+1)
	}
}

func TestHandleEventsFlushErrorTerminatesAndCleansUp(t *testing.T) {
	s := &Server{clients: make([]*sseClient, 0), lastKnown: make(map[string]struct{})}
	req := httptest.NewRequest(http.MethodGet, "/events?id=session.jsonl", nil)
	before := sseProcessMetrics.flushErrs.Load()
	w := &failingSSEWriter{flushErr: errors.New("flush failed")}

	s.handleEventsWithHeartbeat(w, req, nil)

	if got := len(s.clients); got != 0 {
		t.Fatalf("clients after flush error = %d, want 0", got)
	}
	if got := sseProcessMetrics.flushErrs.Load(); got != before+1 {
		t.Fatalf("flush error metric = %d, want %d", got, before+1)
	}
}

func TestHandleEventsForwardsNamedDeltaEvents(t *testing.T) {
	s := &Server{
		sessionsDir: t.TempDir(),
		chatSender:  &fakeSender{},
		clients:     make([]*sseClient, 0),
		lastKnown:   make(map[string]struct{}),
	}

	req := httptest.NewRequest(http.MethodGet, "/events?id=__all__", nil)
	ctx, cancel := context.WithCancel(req.Context())
	req = req.WithContext(ctx)
	w := newSyncRecorder()

	done := make(chan struct{})
	go func() {
		s.handleEvents(w, req)
		close(done)
	}()

	// Wait for the initial :ok, then push a delta and a legacy reload.
	waitFor(t, w, ":ok")
	s.broadcast(globalSessID, "event: status-delta\ndata: {\"id\":\"x\",\"running\":true}")
	s.broadcast(globalSessID, "new-session")
	waitFor(t, w, "event: status-delta")
	waitFor(t, w, "data: new-session")
	cancel()
	<-done

	body := w.body()
	if !strings.Contains(body, "event: status-delta\ndata: {\"id\":\"x\",\"running\":true}") {
		t.Fatalf("expected named delta passthrough, got:\n%s", body)
	}
	if !strings.Contains(body, "data: new-session") {
		t.Fatalf("expected legacy plain-data passthrough, got:\n%s", body)
	}
}

func TestRecordModTimeBroadcastsReloadForKnownZeroModTime(t *testing.T) {
	s := &Server{
		sessionsDir: t.TempDir(),
		clients:     make([]*sseClient, 0),
		fileMod:     map[string]time.Time{"fresh.jsonl": {}},
		lastKnown:   make(map[string]struct{}),
		now:         func() time.Time { return time.Date(2026, 5, 8, 11, 0, 1, 0, time.UTC) },
	}
	client := s.addClient("fresh.jsonl")

	s.recordModTime("fresh.jsonl", time.Date(2026, 5, 8, 11, 0, 0, 0, time.UTC))

	select {
	case got := <-client.ch:
		if got != "reload" {
			t.Fatalf("event = %q, want reload", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for reload")
	}
}
