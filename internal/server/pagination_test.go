package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pican/internal/sessions"
)

func TestSessionBootstrapIncludesProjectionMode(t *testing.T) {
	s := newTestServer(t)
	path := writeSessionFile(t, s.sessionsDir, "proj", "codex.jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"cwd":`, `"runtime":"codex","nativeId":"native","modelProvider":"openai-codex","cwd":`, 1))
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	encoded := s.sessionBootstrap("codex.jsonl")
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	var bootstrap struct {
		Data struct {
			ProjectionMode string `json:"projectionMode"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &bootstrap); err != nil {
		t.Fatal(err)
	}
	if bootstrap.Data.ProjectionMode != "replaceable-projection" {
		t.Fatalf("bootstrap projectionMode = %q, want replaceable-projection", bootstrap.Data.ProjectionMode)
	}
}

// writeSessionWithNMessages scaffolds a session JSONL with `n` message
// entries (plus the leading session header line — so total entries in the
// parsed Session is n+1). Used to exercise the pagination thresholds
// (default 1500 entries → tail-truncate to 1000).
func writeSessionWithNMessages(t *testing.T, root, project, name string, n int) string {
	t.Helper()
	dir := filepath.Join(root, project)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	cwd := filepath.Join(root, "cwd")
	if err := os.MkdirAll(cwd, 0755); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	b.WriteString(`{"type":"session","version":3,"id":"sid","timestamp":"2026-05-06T00:00:00.000Z","cwd":` + jsonString(cwd) + `}` + "\n")
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, `{"type":"message","id":"id%06d","parentId":null,"timestamp":"2026-05-06T00:00:%02d.000Z","message":{"role":"user","content":"m%d"}}`+"\n", i, i%60, i)
	}
	if err := os.WriteFile(path, []byte(b.String()), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHandleApiSession_PaginationWindowed(t *testing.T) {
	root := t.TempDir()
	const messages = 50
	const totalEntries = messages + 1 // session header is entries[0]
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	// Window [10, 15) → 5 entries starting at entries[10].
	// Since entries[0] is the session header, entries[10] is message #9 (id000009).
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&from=10&count=5", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
		From    int              `json:"from"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Total != totalEntries {
		t.Errorf("total = %d, want %d", resp.Total, totalEntries)
	}
	if resp.From != 10 {
		t.Errorf("from = %d, want 10", resp.From)
	}
	if got := len(resp.Entries); got != 5 {
		t.Errorf("got %d entries, want 5", got)
	}
	firstID, _ := resp.Entries[0]["id"].(string)
	if firstID != "id000009" {
		t.Errorf("first entry id = %q, want id000009", firstID)
	}
}

func TestHandleApiSession_PaginationClampsBeyondEnd(t *testing.T) {
	root := t.TempDir()
	const messages = 20
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	// from=15, count=100 → should clamp to entries[15:21] = 6 entries
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&from=15&count=100", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
		From    int              `json:"from"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Total != totalEntries {
		t.Errorf("total = %d, want %d", resp.Total, totalEntries)
	}
	if got := len(resp.Entries); got != totalEntries-15 {
		t.Errorf("clamped entries = %d, want %d", got, totalEntries-15)
	}
}

func TestHandleApiSession_NoPaginationByDefault(t *testing.T) {
	root := t.TempDir()
	const messages = 30
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
		From    int              `json:"from"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.Total != totalEntries {
		t.Errorf("total = %d, want %d", resp.Total, totalEntries)
	}
	if got := len(resp.Entries); got != totalEntries {
		t.Errorf("default (no params) returned %d entries, want all %d", got, totalEntries)
	}
	if resp.From != 0 {
		t.Errorf("from = %d, want 0", resp.From)
	}
}

func TestHandleApiSession_InvalidParamsReturnFull(t *testing.T) {
	root := t.TempDir()
	const messages = 12
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	// from=abc (invalid) → should ignore pagination and return full set.
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&from=abc&count=5", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp struct {
		Entries []map[string]any `json:"entries"`
		Total   int              `json:"total"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Entries) != totalEntries {
		t.Errorf("invalid params: got %d entries, want %d", len(resp.Entries), totalEntries)
	}
}

type deltaResponse struct {
	Entries        []map[string]any `json:"entries"`
	Total          int              `json:"total"`
	From           int              `json:"from"`
	DeltaOk        bool             `json:"deltaOk"`
	ProjectionMode string           `json:"projectionMode"`
}

func TestHandleApiSession_AfterCountReturnsDelta(t *testing.T) {
	root := t.TempDir()
	const messages = 20
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	// Client last saw 15 entries; 6 more (entries[15:21]) exist now.
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&afterCount=15", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp deltaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.DeltaOk {
		t.Fatal("deltaOk = false, want true")
	}
	if resp.ProjectionMode != "append-only-native" {
		t.Fatalf("projectionMode = %q, want append-only-native", resp.ProjectionMode)
	}
	if resp.From != 15 {
		t.Errorf("from = %d, want 15", resp.From)
	}
	if resp.Total != totalEntries {
		t.Errorf("total = %d, want %d", resp.Total, totalEntries)
	}
	if got := len(resp.Entries); got != totalEntries-15 {
		t.Errorf("got %d delta entries, want %d", got, totalEntries-15)
	}
	firstID, _ := resp.Entries[0]["id"].(string)
	if firstID != "id000014" {
		t.Errorf("first delta entry id = %q, want id000014", firstID)
	}
}

func TestHandleApiSession_CodexAfterCountForcesFullReconcile(t *testing.T) {
	root := t.TempDir()
	const messages = 10
	const totalEntries = messages + 1
	path := writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"cwd":`, `"runtime":"codex","nativeId":"native","modelProvider":"openai-codex","cwd":`, 1))
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	registry, err := serverRuntimeRegistry(Deps{EnabledRuntimes: []string{"pi", "codex"}})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{sessionsDir: root, cache: sessions.NewCache(), runtimeRegistry: registry}

	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&afterCount=5", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var resp deltaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.DeltaOk {
		t.Fatal("deltaOk = true, want false for replaceable Codex projection")
	}
	if resp.ProjectionMode != "replaceable-projection" {
		t.Fatalf("projectionMode = %q, want replaceable-projection", resp.ProjectionMode)
	}
	if resp.From != 0 || len(resp.Entries) != totalEntries {
		t.Fatalf("from=%d entries=%d, want full %d-entry reconcile", resp.From, len(resp.Entries), totalEntries)
	}
}

func TestHandleApiSession_UnknownRuntimeAfterCountForcesFullReconcile(t *testing.T) {
	root := t.TempDir()
	const messages = 4
	const totalEntries = messages + 1
	path := writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), `"cwd":`, `"runtime":"future","nativeId":"native","cwd":`, 1))
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&afterCount=2", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	var resp deltaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.DeltaOk || resp.From != 0 || len(resp.Entries) != totalEntries {
		t.Fatalf("unknown runtime delta response = %+v, want full reconcile", resp)
	}
}

func TestHandleApiSession_AfterCountEqualToTotalReturnsEmptyDelta(t *testing.T) {
	root := t.TempDir()
	const messages = 10
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/session?id=s.jsonl&afterCount=%d", totalEntries), nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp deltaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if !resp.DeltaOk {
		t.Fatal("deltaOk = false, want true (afterCount == total is a valid, just-empty, delta)")
	}
	if len(resp.Entries) != 0 {
		t.Errorf("got %d entries, want 0", len(resp.Entries))
	}
}

func TestHandleApiSession_AfterCountBeyondTotalFallsBackToFull(t *testing.T) {
	root := t.TempDir()
	const messages = 10
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	// afterCount is bigger than total — simulates a client whose count is out
	// of sync (e.g. after the session file was replaced). Must self-heal via
	// a full resync rather than silently returning zero entries.
	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&afterCount=999", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp deltaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.DeltaOk {
		t.Fatal("deltaOk = true, want false")
	}
	if resp.From != 0 {
		t.Errorf("from = %d, want 0", resp.From)
	}
	if len(resp.Entries) != totalEntries {
		t.Errorf("got %d entries, want the full %d on fallback", len(resp.Entries), totalEntries)
	}
}

func TestHandleApiSession_AfterCountInvalidFallsBackToFull(t *testing.T) {
	root := t.TempDir()
	const messages = 10
	const totalEntries = messages + 1
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", messages)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl&afterCount=notanumber", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var resp deltaResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.DeltaOk {
		t.Fatal("deltaOk = true, want false")
	}
	if len(resp.Entries) != totalEntries {
		t.Errorf("got %d entries, want the full %d on fallback", len(resp.Entries), totalEntries)
	}
}

func TestHandleApiSession_NoDeltaOkKeyWhenAfterCountAbsent(t *testing.T) {
	root := t.TempDir()
	writeSessionWithNMessages(t, root, "proj", "s.jsonl", 5)
	s := &Server{sessionsDir: root, cache: sessions.NewCache()}

	req := httptest.NewRequest(http.MethodGet, "/api/session?id=s.jsonl", nil)
	w := httptest.NewRecorder()
	s.handleApiSession(w, req)

	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if _, ok := resp["deltaOk"]; ok {
		t.Error("deltaOk key present on a non-delta request; existing callers should see the same shape as before")
	}
}
