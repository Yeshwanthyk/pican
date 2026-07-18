package ui

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

// appStylesBundle concatenates every per-route stylesheet that is NOT needed
// for first paint (theme.css is the exception — see appStylesheets in
// spa_page.go). It is served externally as a single, content-hashed,
// browser-cacheable file instead of being inlined into every SPA shell
// response: inlining ~258KB of CSS on every navigation defeats HTTP caching
// and costs parse time on every route change, even though the CSS itself
// rarely changes between requests.
//
// All routes share this one bundle (simplest correct fix — the browser
// fetches it once and reuses it across every route) rather than splitting it
// per-route; per-route slicing was judged not worth the added complexity.
var appStylesBundle = strings.Join([]string{
	indexCSS,
	settingsCSS,
	schedulesCSS,
	workflowsCSS,
	tasksCSS,
	subagentsCSS,
	liveSessionCss,
	liveMenuCss,
	livePaletteCss,
}, "\n")

// appStylesHash is a short content hash of appStylesBundle, embedded in the
// URL query string so the browser can cache the bundle forever
// (Cache-Control: immutable) while a new build's changed content still gets a
// fresh URL and busts the cache.
var appStylesHash = computeAppStylesHash(appStylesBundle)

var appStylesGzip = gzipCSS(appStylesBundle)

func computeAppStylesHash(css string) string {
	sum := sha256.Sum256([]byte(css))
	return hex.EncodeToString(sum[:])[:12]
}

func gzipCSS(css string) []byte {
	var buf bytes.Buffer
	w, err := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
	if err != nil {
		return []byte(css)
	}
	_, _ = w.Write([]byte(css))
	_ = w.Close()
	return buf.Bytes()
}

// appStylesHref is the versioned URL the SPA shell links to.
func appStylesHref() string {
	return "/styles/app.css?v=" + appStylesHash
}

// ServeAppStyles serves the externalized stylesheet bundle with a long-lived
// immutable cache header — safe because the URL's ?v= query is a content
// hash, so any future content change is served at a new URL rather than
// invalidating this one.
func ServeAppStyles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Vary", "Accept-Encoding")
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write(appStylesGzip)
		return
	}
	_, _ = w.Write([]byte(appStylesBundle))
}
