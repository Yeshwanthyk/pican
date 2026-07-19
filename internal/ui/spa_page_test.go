package ui

import (
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
		`<script type="module" src="/static/assets/app-test.js"></script>`,
		`navigator.serviceWorker.register('/sw.js',{scope:'/'})`,
	} {
		if !strings.Contains(html, want) {
			t.Fatalf("app shell missing %q\n%s", want, html)
		}
	}
}
