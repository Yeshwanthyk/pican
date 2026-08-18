package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"pican/internal/auth"
)

func TestSPAFallbackServesBrowserRoutesButNotAPIsOrAssets(t *testing.T) {
	s := &Server{
		auth: auth.New(""),
		renderAppShell: func(w io.Writer, bootstrap string) error {
			_, err := io.WriteString(w, "spa shell")
			return err
		},
	}
	mux := http.NewServeMux()
	s.Register(mux)

	for _, path := range []string{"/", "/login", "/session", "/settings", "/future-route", "/settings/profile"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK || rec.Body.String() != "spa shell" {
			t.Fatalf("GET %s = (%d, %q), want SPA shell", path, rec.Code, rec.Body.String())
		}
	}

	for _, path := range []string{"/api/unknown", "/static/assets/missing.js", "/missing.js"} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", path, rec.Code)
		}
	}
}

func TestHandleSessionUsesSPAShell(t *testing.T) {
	s := &Server{
		renderAppShell: func(w io.Writer, bootstrap string) error {
			_, err := io.WriteString(w, "spa shell")
			return err
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/session?id=with-pad.jsonl", nil)
	w := httptest.NewRecorder()
	s.handleSession(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if got := w.Body.String(); got != "spa shell" {
		t.Fatalf("expected SPA shell, got %q", got)
	}
}
