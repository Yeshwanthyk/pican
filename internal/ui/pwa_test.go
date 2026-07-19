package ui

import (
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCodexIconIsServed(t *testing.T) {
	mux := http.NewServeMux()
	RegisterPWAHandlers(mux)

	req := httptest.NewRequest(http.MethodGet, "/codex-icon.svg", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/svg+xml" {
		t.Fatalf("Content-Type = %q, want image/svg+xml", got)
	}
	if body := rec.Body.String(); !strings.Contains(body, "<title>Codex</title>") || !strings.Contains(body, "#6F8CFF") {
		t.Fatalf("unexpected Codex icon: %q", body)
	}
}

func TestAppIconIsServedAndInstalled(t *testing.T) {
	mux := http.NewServeMux()
	RegisterPWAHandlers(mux)

	req := httptest.NewRequest(http.MethodGet, "/app-icon.png", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", got)
	}
	image, err := png.Decode(strings.NewReader(rec.Body.String()))
	if err != nil {
		t.Fatalf("decode app icon: %v", err)
	}
	if got := image.Bounds().Dx(); got != 1024 {
		t.Fatalf("icon width = %d, want 1024", got)
	}
	if got := image.Bounds().Dy(); got != 1024 {
		t.Fatalf("icon height = %d, want 1024", got)
	}

	var manifest struct {
		Name      string `json:"name"`
		ShortName string `json:"short_name"`
		ID        string `json:"id"`
		Icons     []struct {
			Src  string `json:"src"`
			Type string `json:"type"`
		} `json:"icons"`
	}
	if err := json.Unmarshal([]byte(manifestJSON), &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if manifest.Name != "pican" || manifest.ShortName != "pican" {
		t.Fatalf("manifest names = %q/%q, want pican/pican", manifest.Name, manifest.ShortName)
	}
	if manifest.ID != "/pican" {
		t.Fatalf("manifest id = %q, want /pican", manifest.ID)
	}
	for _, icon := range manifest.Icons {
		if icon.Src == "/app-icon.png" && icon.Type == "image/png" {
			return
		}
	}
	t.Fatal("manifest does not install /app-icon.png")
}
