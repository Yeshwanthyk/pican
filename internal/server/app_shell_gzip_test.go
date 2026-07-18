package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"pi-web/internal/auth"
)

// TestHandleAppShellGzipsWhenAcceptEncodingAllows is a regression test for
// serving the (uncompressed, dynamically-rendered) SPA shell: it should be
// gzip-compressed like every other static asset when the client advertises
// support, and served as plain text/html otherwise.
func TestHandleAppShellGzipsWhenAcceptEncodingAllows(t *testing.T) {
	const shellHTML = "<html><body>spa shell content that is reasonably long so gzip helps</body></html>"
	s := &Server{
		auth: auth.New(""),
		renderAppShell: func(w io.Writer, bootstrap string) error {
			_, err := io.WriteString(w, shellHTML)
			return err
		},
	}
	mux := http.NewServeMux()
	s.Register(mux)

	t.Run("gzip requested", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Accept-Encoding", "gzip, deflate, br")
		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("Content-Encoding = %q, want gzip", got)
		}
		if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Fatalf("Vary = %q, want Accept-Encoding", got)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache, no-store, must-revalidate" {
			t.Fatalf("Cache-Control = %q, unexpectedly changed", got)
		}

		gr, err := gzip.NewReader(rec.Body)
		if err != nil {
			t.Fatalf("gzip.NewReader: %v", err)
		}
		defer gr.Close()
		decoded, err := io.ReadAll(gr)
		if err != nil {
			t.Fatalf("read gzip body: %v", err)
		}
		if string(decoded) != shellHTML {
			t.Fatalf("decoded body = %q, want %q", decoded, shellHTML)
		}
	})

	t.Run("no gzip support", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		mux.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Fatalf("Content-Encoding = %q, want empty", got)
		}
		if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
			t.Fatalf("Vary = %q, want Accept-Encoding", got)
		}
		if rec.Body.String() != shellHTML {
			t.Fatalf("body = %q, want plain shell html", rec.Body.String())
		}
	})
}
