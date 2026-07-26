package ui

import (
	"bytes"
	_ "embed"
	"net/http"
	"strconv"
	"strings"
	"time"
)

//go:embed embedded/assets/manifest.webmanifest
var manifestJSON string

//go:embed embedded/assets/sw.js
var swJS string

//go:embed embedded/assets/pi-icon.svg
var piIconSVG string

//go:embed embedded/assets/codex-icon.svg
var codexIconSVG string

//go:embed embedded/assets/claude-icon.svg
var claudeIconSVG string

//go:embed embedded/assets/icon-maskable.svg
var iconMaskableSVG string

//go:embed embedded/assets/app-icon.png
var appIconPNG []byte

//go:embed embedded/assets/pi-logo.svg
var piLogoSVG string

//go:embed embedded/assets/cat.mp3
var CatMP3 []byte

//go:embed embedded/assets/done.mp3
var DoneMP3 []byte

//go:embed embedded/assets/cat.webm
var catWebm []byte

// indexCSS and settingsCSS are inlined into the SPA shell by
// appStylesheets() (spa_page.go); they are not served as standalone routes.
//
//go:embed embedded/styles/index.css
var indexCSS string

//go:embed embedded/styles/settings.css
var settingsCSS string

//go:embed embedded/styles/schedules.css
var schedulesCSS string

//go:embed embedded/styles/workflows.css
var workflowsCSS string

//go:embed embedded/styles/tasks.css
var tasksCSS string

//go:embed embedded/styles/subagents.css
var subagentsCSS string

// registerPWAHandlers serves the manifest, service worker, and icons.
// Routes are registered without auth: a manifest/icon leaks nothing
// sensitive, and the service worker must be reachable for installability
// even before the user authenticates.
func RegisterPWAHandlers(mux *http.ServeMux) {
	mux.HandleFunc("/manifest.webmanifest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/manifest+json")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write([]byte(liveManifestJSON()))
	})
	mux.HandleFunc("/sw.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		// Allow the SW to control exactly the configured live-app mount.
		w.Header().Set("Service-Worker-Allowed", liveURL("/"))
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write([]byte("const PICAN_BASE_PATH = " + strconv.Quote(liveBasePath.String()) + ";\n" + swJS))
	})
	mux.HandleFunc("/icon.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte(piIconSVG))
	})
	mux.HandleFunc("/pi-icon.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte(piIconSVG))
	})
	mux.HandleFunc("/codex-icon.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte(codexIconSVG))
	})
	mux.HandleFunc("/claude-icon.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte(claudeIconSVG))
	})
	mux.HandleFunc("/icon-maskable.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte(iconMaskableSVG))
	})
	mux.HandleFunc("/app-icon.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(appIconPNG)
	})
	mux.HandleFunc("/pi-logo.svg", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write([]byte(piLogoSVG))
	})
	mux.HandleFunc("/cat.webm", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/webm")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		http.ServeContent(w, r, "cat.webm", time.Time{}, bytes.NewReader(catWebm))
	})
}

func liveManifestJSON() string {
	out := manifestJSON
	replacements := map[string]string{
		`"/pican"`:        strconv.Quote(liveURL("/pican")),
		`"/"`:             strconv.Quote(liveURL("/")),
		`"/app-icon.png"`: strconv.Quote(liveURL("/app-icon.png")),
	}
	// Replace specific values before the generic root scope/start_url value.
	out = strings.ReplaceAll(out, `"/app-icon.png"`, replacements[`"/app-icon.png"`])
	out = strings.ReplaceAll(out, `"/pican"`, replacements[`"/pican"`])
	out = strings.ReplaceAll(out, `"/"`, replacements[`"/"`])
	return out
}
