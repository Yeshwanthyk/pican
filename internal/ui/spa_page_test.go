package ui

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAppShellPreservesPWAContract(t *testing.T) {
	old := appScriptPath
	appScriptPath = "/static/assets/app-test.js"
	defer func() { appScriptPath = old }()

	var b strings.Builder
	if err := RenderAppShell(&b, ""); err != nil {
		t.Fatalf("RenderAppShell: %v", err)
	}
	html := b.String()
	for _, want := range []string{
		`<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, interactive-widget=resizes-content">`,
		`<link rel="icon" type="image/png" href="/app-icon.png">`,
		`<link rel="apple-touch-icon" href="/app-icon.png">`,
		`<link rel="manifest" href="/manifest.webmanifest">`,
		`<meta name="theme-color" content="#0e0e13">`,
		`<meta name="mobile-web-app-capable" content="yes">`,
		`<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`,
		`<title>pican</title>`,
		`<meta name="apple-mobile-web-app-title" content="pican">`,
		`<meta name="pican-theme"`,
		`navigator.windowControlsOverlay`,
		`<link rel="stylesheet" href="/custom-themes.css">`,
		`<style id="pican-fonts">`,
		`<div id="spa-root"></div>`,
		`<script id="pican-application-context" type="application/json">{"mode":"standalone"}</script>`,
		`<script type="module" src="/static/assets/app-test.js"></script>`,
		`navigator.serviceWorker.register('/sw.js',{scope:'/'})`,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("app shell missing %q\n%s", want, html)
		}
	}
}

func TestHostedAppShellIncludesContextWithoutPWA(t *testing.T) {
	var b strings.Builder
	if err := RenderAppShellWithContext(&b, "", ApplicationContext{
		Mode: ApplicationModeHosted,
	}); err != nil {
		t.Fatal(err)
	}
	html := b.String()
	for _, want := range []string{
		`<script id="pican-application-context" type="application/json">{"mode":"hosted"}</script>`,
		`<div id="spa-root"></div>`,
		`<script type="module"`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("hosted shell missing %q", want)
		}
	}
	for _, forbidden := range []string{
		`rel="manifest"`,
		`mobile-web-app-capable`,
		`apple-mobile-web-app-title`,
		`navigator.serviceWorker.register`,
		`/sw.js`,
	} {
		if strings.Contains(html, forbidden) {
			t.Errorf("hosted shell contains PWA markup %q", forbidden)
		}
	}
}

func TestAppShellEscapesOptionalHostNavigationURL(t *testing.T) {
	hostNavigationURL := `https://host.example/workspaces/test?next=</script><script>alert("x")</script>&label=host`
	var b strings.Builder
	if err := RenderAppShellWithContext(&b, "", ApplicationContext{
		Mode:              ApplicationModeHosted,
		HostNavigationURL: hostNavigationURL,
	}); err != nil {
		t.Fatal(err)
	}
	html := b.String()
	if strings.Contains(html, hostNavigationURL) || strings.Contains(html, `<script>alert`) {
		t.Fatal("host navigation URL was not safely escaped")
	}
	contextJSON := applicationContextJSON(t, html)
	var context ApplicationContext
	if err := json.Unmarshal([]byte(contextJSON), &context); err != nil {
		t.Fatalf("decode application context: %v", err)
	}
	if context.Mode != ApplicationModeHosted || context.HostNavigationURL != hostNavigationURL {
		t.Fatalf("application context = %+v", context)
	}
}

func applicationContextJSON(t *testing.T, html string) string {
	t.Helper()
	const start = `<script id="pican-application-context" type="application/json">`
	startIndex := strings.Index(html, start)
	if startIndex < 0 {
		t.Fatal("application context script not found")
	}
	valueStart := startIndex + len(start)
	valueEnd := strings.Index(html[valueStart:], `</script>`)
	if valueEnd < 0 {
		t.Fatal("application context script is not closed")
	}
	return html[valueStart : valueStart+valueEnd]
}

func TestAppShellUsesMountedLiveURLs(t *testing.T) {
	if err := SetBasePath("/s/test"); err != nil {
		t.Fatal(err)
	}
	defer SetBasePath("")
	old := appScriptPath
	appScriptPath = "/static/assets/app-hash.js"
	defer func() { appScriptPath = old }()

	var b strings.Builder
	if err := RenderAppShell(&b, ""); err != nil {
		t.Fatal(err)
	}
	html := b.String()
	for _, want := range []string{
		`name="pican-base-path" content="/s/test"`,
		`href="/s/test/app-icon.png"`,
		`href="/s/test/manifest.webmanifest"`,
		`href="/s/test/styles/app.css?v=`,
		`src="/s/test/static/assets/app-hash.js"`,
		`register('/s/test/sw.js',{scope:'/s/test/'})`,
	} {
		if !strings.Contains(html, want) {
			t.Errorf("shell missing %q", want)
		}
	}
}
