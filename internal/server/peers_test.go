package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func newPeersDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if _, err := db.Exec(peerHostsSchema); err != nil {
		t.Fatalf("create peer_hosts: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func newPeersServer(t *testing.T) *Server {
	t.Helper()
	return &Server{
		db:  newPeersDB(t),
		now: func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) },
	}
}

func postPeers(t *testing.T, s *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/peers", strings.NewReader(body))
	w := httptest.NewRecorder()
	s.handleUpdatePeer(w, req)
	return w
}

func getPeers(t *testing.T, s *Server) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/peers", nil)
	w := httptest.NewRecorder()
	s.handleApiPeers(w, req)
	return w
}

// TestHandleUpdatePeer_UpsertNeverLeaksToken verifies a peer can be added with
// a token and that GET /api/peers reports hasToken without ever including the
// token value itself in the response body.
func TestHandleUpdatePeer_UpsertNeverLeaksToken(t *testing.T) {
	s := newPeersServer(t)

	w := postPeers(t, s, `{"name":"mac-mini","baseUrl":"https://mac-mini.tailnet.ts.net:31415","token":"sekret-token"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("upsert: status = %d, body = %s", w.Code, w.Body.String())
	}

	w = getPeers(t, s)
	if w.Code != http.StatusOK {
		t.Fatalf("list: status = %d, body = %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "sekret-token") {
		t.Fatalf("token leaked in GET /api/peers response: %s", w.Body.String())
	}
	var resp struct {
		Peers []peerEntry `json:"peers"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Peers) != 1 {
		t.Fatalf("peers = %+v, want 1 entry", resp.Peers)
	}
	got := resp.Peers[0]
	if got.Name != "mac-mini" || got.BaseURL != "https://mac-mini.tailnet.ts.net:31415" || !got.HasToken {
		t.Fatalf("peer entry = %+v, want name=mac-mini hasToken=true", got)
	}

	hosts, err := s.listPeerHosts()
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 1 || hosts[0].Token != "sekret-token" {
		t.Fatalf("stored token = %+v, want sekret-token", hosts)
	}
}

// TestHandleUpdatePeer_EmptyTokenKeepsExisting verifies that re-upserting a
// peer with an empty token field leaves the previously stored token intact,
// while an empty baseUrl update still updates the URL.
func TestHandleUpdatePeer_EmptyTokenKeepsExisting(t *testing.T) {
	s := newPeersServer(t)
	postPeers(t, s, `{"name":"mac-mini","baseUrl":"https://mac-mini.ts.net:31415","token":"original-token"}`)

	w := postPeers(t, s, `{"name":"mac-mini","baseUrl":"https://mac-mini.ts.net:31416","token":""}`)
	if w.Code != http.StatusOK {
		t.Fatalf("update: status = %d, body = %s", w.Code, w.Body.String())
	}

	hosts, err := s.listPeerHosts()
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 1 {
		t.Fatalf("hosts = %+v, want 1", hosts)
	}
	if hosts[0].BaseURL != "https://mac-mini.ts.net:31416" {
		t.Fatalf("baseUrl = %q, want updated URL", hosts[0].BaseURL)
	}
	if hosts[0].Token != "original-token" {
		t.Fatalf("token = %q, want original-token preserved", hosts[0].Token)
	}
}

func TestHandleUpdatePeer_Remove(t *testing.T) {
	s := newPeersServer(t)
	postPeers(t, s, `{"name":"mac-mini","baseUrl":"https://mac-mini.ts.net:31415"}`)

	w := postPeers(t, s, `{"name":"mac-mini","action":"remove"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("remove: status = %d, body = %s", w.Code, w.Body.String())
	}
	hosts, err := s.listPeerHosts()
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 0 {
		t.Fatalf("hosts after remove = %+v, want none", hosts)
	}
}

func TestHandleUpdatePeer_Validation(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		body       string
		wantStatus int
	}{
		{"missing name", http.MethodPost, `{"baseUrl":"https://x.ts.net:31415"}`, http.StatusBadRequest},
		{"missing baseUrl", http.MethodPost, `{"name":"x"}`, http.StatusBadRequest},
		{"relative baseUrl", http.MethodPost, `{"name":"x","baseUrl":"x.ts.net:31415"}`, http.StatusBadRequest},
		{"non-http scheme", http.MethodPost, `{"name":"x","baseUrl":"ftp://x.ts.net"}`, http.StatusBadRequest},
		{"invalid json", http.MethodPost, `{`, http.StatusBadRequest},
		{"wrong method", http.MethodGet, ``, http.StatusMethodNotAllowed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newPeersServer(t)
			req := httptest.NewRequest(tt.method, "/api/peers", strings.NewReader(tt.body))
			w := httptest.NewRecorder()
			s.handleUpdatePeer(w, req)
			if w.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s", w.Code, tt.wantStatus, w.Body.String())
			}
		})
	}
}

// TestNormalizePeerBaseURL covers trailing-slash stripping and scheme
// validation.
func TestNormalizePeerBaseURL(t *testing.T) {
	tests := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"https://mac-mini.ts.net:31415", "https://mac-mini.ts.net:31415", false},
		{"https://mac-mini.ts.net:31415/", "https://mac-mini.ts.net:31415", false},
		{"  https://mac-mini.ts.net:31415  ", "https://mac-mini.ts.net:31415", false},
		{"", "", true},
		{"not-a-url", "", true},
		{"ftp://mac-mini.ts.net", "", true},
	}
	for _, tt := range tests {
		got, err := normalizePeerBaseURL(tt.in)
		if tt.wantErr {
			if err == nil {
				t.Errorf("normalizePeerBaseURL(%q) = %q, want error", tt.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("normalizePeerBaseURL(%q) unexpected error: %v", tt.in, err)
			continue
		}
		if got != tt.want {
			t.Errorf("normalizePeerBaseURL(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func newFakePeerServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

// TestHandlePeersSessions_AggregationHappyPath fans out to two fake peers and
// verifies both come back online with sessions augmented with host/hostUrl.
func TestHandlePeersSessions_AggregationHappyPath(t *testing.T) {
	s := newPeersServer(t)

	peerA := newFakePeerServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sessions":[{"ID":"a1.jsonl","Name":"session a1"}],"total":1}`))
	})
	peerB := newFakePeerServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sessions":[{"ID":"b1.jsonl","Name":"session b1"}],"total":1}`))
	})

	postPeers(t, s, `{"name":"peer-a","baseUrl":"`+peerA.URL+`"}`)
	postPeers(t, s, `{"name":"peer-b","baseUrl":"`+peerB.URL+`"}`)

	req := httptest.NewRequest(http.MethodGet, "/api/peers/sessions", nil)
	w := httptest.NewRecorder()
	s.handlePeersSessions(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		Hosts []peerSessionsHost `json:"hosts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Hosts) != 2 {
		t.Fatalf("hosts = %+v, want 2", resp.Hosts)
	}
	byName := map[string]peerSessionsHost{}
	for _, h := range resp.Hosts {
		byName[h.Name] = h
	}
	a, ok := byName["peer-a"]
	if !ok || !a.Online || a.Error != "" || len(a.Sessions) != 1 {
		t.Fatalf("peer-a = %+v", a)
	}
	if a.Sessions[0]["host"] != "peer-a" || a.Sessions[0]["hostUrl"] != peerA.URL {
		t.Fatalf("peer-a session not augmented: %+v", a.Sessions[0])
	}
	b, ok := byName["peer-b"]
	if !ok || !b.Online || len(b.Sessions) != 1 {
		t.Fatalf("peer-b = %+v", b)
	}
}

// TestHandlePeersSessions_TokenHeaderSent verifies the configured token is
// sent as X-Pi-Token, and that no header is sent when no token is configured.
func TestHandlePeersSessions_TokenHeaderSent(t *testing.T) {
	s := newPeersServer(t)

	var gotToken, gotTokenNoAuth string
	withToken := newFakePeerServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotToken = r.Header.Get("X-Pi-Token")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sessions":[]}`))
	})
	withoutToken := newFakePeerServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotTokenNoAuth = r.Header.Get("X-Pi-Token")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sessions":[]}`))
	})

	postPeers(t, s, `{"name":"secured","baseUrl":"`+withToken.URL+`","token":"my-token"}`)
	postPeers(t, s, `{"name":"open","baseUrl":"`+withoutToken.URL+`"}`)

	req := httptest.NewRequest(http.MethodGet, "/api/peers/sessions", nil)
	w := httptest.NewRecorder()
	s.handlePeersSessions(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if gotToken != "my-token" {
		t.Fatalf("X-Pi-Token sent to secured peer = %q, want my-token", gotToken)
	}
	if gotTokenNoAuth != "" {
		t.Fatalf("X-Pi-Token sent to peer with no configured token = %q, want empty", gotTokenNoAuth)
	}
}

// TestHandlePeersSessions_Unauthorized verifies a peer returning 401 is
// reported offline with error "unauthorized".
func TestHandlePeersSessions_Unauthorized(t *testing.T) {
	s := newPeersServer(t)
	peer := newFakePeerServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	postPeers(t, s, `{"name":"locked","baseUrl":"`+peer.URL+`","token":"wrong"}`)

	req := httptest.NewRequest(http.MethodGet, "/api/peers/sessions", nil)
	w := httptest.NewRecorder()
	s.handlePeersSessions(w, req)

	var resp struct {
		Hosts []peerSessionsHost `json:"hosts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Hosts) != 1 {
		t.Fatalf("hosts = %+v, want 1", resp.Hosts)
	}
	host := resp.Hosts[0]
	if host.Online || host.Error != "unauthorized" {
		t.Fatalf("host = %+v, want online=false error=unauthorized", host)
	}
	if len(host.Sessions) != 0 {
		t.Fatalf("sessions = %+v, want empty", host.Sessions)
	}
}

// TestHandlePeersSessions_UnreachableTimesOut verifies a peer that never
// responds within peerFetchTimeout is marked offline rather than hanging the
// whole request, and that a genuinely unreachable peer doesn't block a
// healthy one running concurrently.
func TestHandlePeersSessions_UnreachableTimesOut(t *testing.T) {
	s := newPeersServer(t)

	orig := peerFetchTimeout
	peerFetchTimeout = 100 * time.Millisecond
	t.Cleanup(func() { peerFetchTimeout = orig })

	blocked := make(chan struct{})
	slow := newFakePeerServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-blocked:
		case <-r.Context().Done():
		}
	})
	t.Cleanup(func() { close(blocked) })

	fast := newFakePeerServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"sessions":[]}`))
	})

	postPeers(t, s, `{"name":"slow","baseUrl":"`+slow.URL+`"}`)
	postPeers(t, s, `{"name":"fast","baseUrl":"`+fast.URL+`"}`)

	start := time.Now()
	req := httptest.NewRequest(http.MethodGet, "/api/peers/sessions", nil)
	w := httptest.NewRecorder()
	s.handlePeersSessions(w, req)
	elapsed := time.Since(start)

	if elapsed > 2*time.Second {
		t.Fatalf("handlePeersSessions took %v, want bounded by peerFetchTimeout", elapsed)
	}

	var resp struct {
		Hosts []peerSessionsHost `json:"hosts"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	byName := map[string]peerSessionsHost{}
	for _, h := range resp.Hosts {
		byName[h.Name] = h
	}
	if byName["slow"].Online {
		t.Fatalf("slow peer = %+v, want online=false", byName["slow"])
	}
	if byName["slow"].Error == "" {
		t.Fatal("slow peer should report a non-empty error")
	}
	if !byName["fast"].Online {
		t.Fatalf("fast peer = %+v, want online=true (must not be blocked by the slow one)", byName["fast"])
	}
}
