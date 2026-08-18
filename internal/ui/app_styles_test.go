package ui

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestServeAppStylesSetsImmutableCacheHeader(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/styles/app.css", nil)
	rec := httptest.NewRecorder()

	ServeAppStyles(rec, req)

	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("Cache-Control = %q, want immutable long-lived cache", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/css") {
		t.Fatalf("Content-Type = %q, want text/css", got)
	}
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("expected no Content-Encoding without an Accept-Encoding request header")
	}
	if body := rec.Body.String(); body != appStylesBundle {
		t.Fatalf("served body does not match appStylesBundle (len %d vs %d)", len(body), len(appStylesBundle))
	}
}

func TestServeAppStylesGzipsWhenAccepted(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/styles/app.css", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()

	ServeAppStyles(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	gr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	decoded, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	if string(decoded) != appStylesBundle {
		t.Fatalf("decoded gzip body does not match appStylesBundle (len %d vs %d)", len(decoded), len(appStylesBundle))
	}
}

func TestAppStylesBundleContainsPerRouteStylesheets(t *testing.T) {
	for name, css := range map[string]string{
		"indexCSS":       indexCSS,
		"settingsCSS":    settingsCSS,
		"workflowsCSS":   workflowsCSS,
		"tasksCSS":       tasksCSS,
		"subagentsCSS":   subagentsCSS,
		"liveSessionCss": liveSessionCss,
		"liveMenuCss":    liveMenuCss,
		"livePaletteCss": livePaletteCss,
	} {
		if css == "" {
			continue // an empty embedded stylesheet trivially satisfies "contains"
		}
		if !strings.Contains(appStylesBundle, css) {
			t.Fatalf("appStylesBundle missing %s", name)
		}
	}
	if strings.Contains(appStylesBundle, "--pican-theme-boot-marker--") {
		t.Fatalf("sanity check sentinel unexpectedly present")
	}
}

func TestAppShellInlinesOnlyThemeAndLinksTheRest(t *testing.T) {
	old := appScriptPath
	appScriptPath = "/static/assets/app-test.js"
	defer func() { appScriptPath = old }()

	var b strings.Builder
	if err := RenderAppShell(&b, ""); err != nil {
		t.Fatalf("RenderAppShell: %v", err)
	}
	html := b.String()

	if !strings.Contains(html, "<style>\n"+liveThemeCss+"\n</style>") {
		t.Fatalf("app shell no longer inlines theme.css")
	}
	wantLink := `<link rel="stylesheet" href="/styles/app.css?v=` + appStylesHash + `">`
	if !strings.Contains(html, wantLink) {
		t.Fatalf("app shell missing external stylesheet link %q\n%s", wantLink, html)
	}
	// The large per-route stylesheets must no longer be inlined verbatim into
	// the shell — only linked. liveSessionCss is ~5k lines; its presence here
	// would mean the fix regressed back to full inlining.
	if strings.Contains(html, liveSessionCss) {
		t.Fatalf("app shell still inlines liveSessionCss verbatim")
	}
}
