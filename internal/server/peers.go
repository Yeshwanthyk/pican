package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// peer_hosts records other pi-web instances (reached over Tailscale) whose
// sessions should be aggregated into a read-only "Machines" view on the
// homepage. Session ids are bare filenames and are not unique across
// machines, so navigation to a peer session is always a deep link to the
// peer's own /session page — never local routing. See docs/sequence-flows/peers.md.
const peerHostsSchema = `CREATE TABLE IF NOT EXISTS peer_hosts (
	name TEXT PRIMARY KEY,
	base_url TEXT NOT NULL,
	token TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
)`

// peerFetchTimeout bounds how long the fan-out in handlePeersSessions waits
// for any single peer. A var (not a const) so tests can shrink it instead of
// sleeping for the real timeout.
var peerFetchTimeout = 3 * time.Second

// peerHTTPClient is shared across every peer request so connections and the
// transport's idle-conn pool are reused instead of dialing fresh per fan-out.
var peerHTTPClient = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        20,
		MaxIdleConnsPerHost: 5,
		IdleConnTimeout:     30 * time.Second,
	},
}

var (
	errPeerNameRequired   = errors.New("name is required")
	errPeerBaseURLInvalid = errors.New("baseUrl must be an absolute http:// or https:// URL")
)

type peerHost struct {
	Name    string
	BaseURL string
	Token   string
}

// peerEntry is the /api/peers wire shape. The token itself is never included.
type peerEntry struct {
	Name     string `json:"name"`
	BaseURL  string `json:"baseUrl"`
	HasToken bool   `json:"hasToken"`
}

// normalizePeerBaseURL strips a trailing slash and requires an absolute
// http(s) URL so `baseURL + "/api/..."` is always well-formed.
func normalizePeerBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimSuffix(raw, "/")
	if raw == "" {
		return "", errPeerBaseURLInvalid
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errPeerBaseURLInvalid
	}
	return raw, nil
}

// listPeerHosts returns every registered peer, name-sorted. Empty (not an
// error) when there is no database.
func (s *Server) listPeerHosts() ([]peerHost, error) {
	if s.db == nil {
		return nil, nil
	}
	rows, err := s.db.Query("SELECT name, base_url, token FROM peer_hosts ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []peerHost
	for rows.Next() {
		var p peerHost
		if err := rows.Scan(&p.Name, &p.BaseURL, &p.Token); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Server) handleApiPeers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	hosts, err := s.listPeerHosts()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	entries := make([]peerEntry, 0, len(hosts))
	for _, h := range hosts {
		entries = append(entries, peerEntry{Name: h.Name, BaseURL: h.BaseURL, HasToken: h.Token != ""})
	}
	writeJSON(w, 0, map[string]any{"peers": entries})
}

// handleUpdatePeer upserts (name + baseUrl, optional token) or removes
// (action:"remove") a peer host. Mirrors handleUpdateProject's shape: a
// single POST endpoint keyed by an "action" field.
func (s *Server) handleUpdatePeer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s.db == nil {
		writeJSONError(w, http.StatusInternalServerError, "peers are unavailable")
		return
	}
	var body struct {
		Name    string `json:"name"`
		BaseURL string `json:"baseUrl"`
		Token   string `json:"token"`
		Action  string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeJSONError(w, http.StatusBadRequest, errPeerNameRequired.Error())
		return
	}

	if body.Action == "remove" {
		if _, err := s.db.Exec("DELETE FROM peer_hosts WHERE name = ?", name); err != nil {
			writeJSONError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, 0, map[string]any{"ok": true, "name": name})
		return
	}

	baseURL, err := normalizePeerBaseURL(body.BaseURL)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	now := s.now().Format(time.RFC3339)
	token := strings.TrimSpace(body.Token)
	if token == "" {
		// Empty token on an update keeps whatever token (if any) is already
		// stored; only base_url changes. On first insert this leaves '' (the
		// column default).
		_, err = s.db.Exec(`INSERT INTO peer_hosts (name, base_url, token, created_at)
			VALUES (?, ?, '', ?)
			ON CONFLICT(name) DO UPDATE SET base_url = excluded.base_url`, name, baseURL, now)
	} else {
		_, err = s.db.Exec(`INSERT INTO peer_hosts (name, base_url, token, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(name) DO UPDATE SET base_url = excluded.base_url, token = excluded.token`,
			name, baseURL, token, now)
	}
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, 0, map[string]any{"ok": true, "name": name})
}

// peerSessionsHost is one entry in GET /api/peers/sessions' "hosts" array.
type peerSessionsHost struct {
	Name     string           `json:"name"`
	BaseURL  string           `json:"baseUrl"`
	Online   bool             `json:"online"`
	Error    string           `json:"error"`
	Sessions []map[string]any `json:"sessions"`
}

// handlePeersSessions fans out GET <baseUrl>/api/sessions?limit=50 to every
// registered peer concurrently and merges the results. It never proxies
// session content or chat — this is a read-only, aggregated summary list.
func (s *Server) handlePeersSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	hosts, err := s.listPeerHosts()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	results := make([]peerSessionsHost, len(hosts))
	var wg sync.WaitGroup
	for i, h := range hosts {
		wg.Add(1)
		go func(i int, h peerHost) {
			defer wg.Done()
			results[i] = fetchPeerSessions(r.Context(), h)
		}(i, h)
	}
	wg.Wait()

	writeJSON(w, 0, map[string]any{"hosts": results})
}

// fetchPeerSessions calls one peer's /api/sessions and never returns an
// error — unreachable/unauthorized/slow peers are reported as
// online:false with a short Error string so one bad peer never blocks (or
// fails) the aggregated response.
func fetchPeerSessions(ctx context.Context, h peerHost) peerSessionsHost {
	out := peerSessionsHost{Name: h.Name, BaseURL: h.BaseURL, Sessions: []map[string]any{}}

	ctx, cancel := context.WithTimeout(ctx, peerFetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.BaseURL+"/api/sessions?limit=50", nil)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	req.Header.Set("Accept", "application/json")
	if h.Token != "" {
		req.Header.Set("X-Pi-Token", h.Token)
	}

	resp, err := peerHTTPClient.Do(req)
	if err != nil {
		out.Error = "unreachable"
		return out
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		out.Error = "unauthorized"
		return out
	}
	if resp.StatusCode != http.StatusOK {
		out.Error = fmt.Sprintf("http %d", resp.StatusCode)
		return out
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		out.Error = "read failed"
		return out
	}
	var parsed struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		out.Error = "invalid response"
		return out
	}

	for _, sess := range parsed.Sessions {
		sess["host"] = h.Name
		sess["hostUrl"] = h.BaseURL
	}
	out.Online = true
	out.Sessions = parsed.Sessions
	return out
}
