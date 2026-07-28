package ui

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"html/template"
	"io"
)

//go:embed embedded/app.html
var appTmplStr string

var appTmpl = template.Must(template.New("app").Parse(appTmplStr))

const (
	ApplicationModeStandalone = "standalone"
	ApplicationModeHosted     = "hosted"
)

// ApplicationContext is the complete browser-visible startup contract. Keep
// this deliberately small: startup roots, authentication, child environment,
// credentials, and runtime/provider details never belong in initial HTML.
type ApplicationContext struct {
	Mode              string `json:"mode"`
	HostNavigationURL string `json:"hostNavigationUrl,omitempty"`
}

func (c ApplicationContext) normalized() ApplicationContext {
	if c.Mode != ApplicationModeHosted {
		c.Mode = ApplicationModeStandalone
	}
	return c
}

// appStylesheets returns the CSS the SPA shell needs before first paint —
// theme.css only, inlined so its tokens (and the boot script's FOUC
// prevention, which reads them) are available with zero extra round-trips —
// plus a <link> to the externally cached bundle of everything else
// (appStylesBundle in app_styles.go). Splitting it this way means the ~258KB
// of per-route CSS is fetched once by the browser and cached across every
// subsequent navigation instead of being re-transmitted and re-parsed inline
// on every route.
func appStylesheets() template.HTML {
	return template.HTML("<style>\n" + liveThemeCss + "\n</style>\n" +
		`<link rel="stylesheet" href="` + template.HTMLEscapeString(appStylesHref()) + `">`)
}

// RenderAppShell renders the Svelte SPA host document. It deliberately reuses
// the same live-document boot path as the existing Go-rendered pages so the
// installed PWA keeps its viewport, theme, WCO, font, and service-worker
// behavior while routes migrate into Svelte incrementally.
//
// bootstrap, when non-empty, is the base64 session payload the SPA reads to
// render the first paint without fetching /api/session — see the session route.
func RenderAppShell(w io.Writer, bootstrap string) error {
	return RenderAppShellWithContext(w, bootstrap, ApplicationContext{
		Mode: ApplicationModeStandalone,
	})
}

// RenderAppShellWithContext renders the SPA host document with its validated,
// non-secret application context available before the frontend module runs.
func RenderAppShellWithContext(w io.Writer, bootstrap string, applicationContext ApplicationContext) error {
	applicationContext = applicationContext.normalized()
	scriptSrc := template.HTMLEscapeString(liveURL(appScriptPath))
	preload := template.HTML(`<link rel="modulepreload" href="` + scriptSrc + `">`)
	contextJSON, err := json.Marshal(applicationContext)
	if err != nil {
		return err
	}
	contextTag := template.HTML(`<script id="pican-application-context" type="application/json">` + string(contextJSON) + `</script>`)
	bootstrapTag := template.HTML("")
	if bootstrap != "" {
		// base64 only (A-Za-z0-9+/=), so it cannot break out of the script tag.
		bootstrapTag = template.HTML(`<script id="pican-session-bootstrap" type="application/json">` + template.HTMLEscapeString(bootstrap) + `</script>`)
	}
	data := struct {
		LiveDocumentStart  template.HTML
		ThemeBoot          template.HTML
		ApplicationContext template.HTML
		Bootstrap          template.HTML
		AppScript          template.HTML
		ServiceWorker      template.HTML
		LiveDocumentEnd    template.HTML
	}{
		LiveDocumentStart: template.HTML(renderLiveDocumentStart(liveDocumentData{
			Title:   "pican",
			Preload: preload,
			Styles:  appStylesheets(),
			PWA:     applicationContext.Mode == ApplicationModeStandalone,
		})),
		ThemeBoot:          liveThemeBootScript(),
		ApplicationContext: contextTag,
		Bootstrap:          bootstrapTag,
		AppScript:          template.HTML(`<script type="module" src="` + scriptSrc + `"></script>`),
		LiveDocumentEnd:    liveDocumentEnd(),
	}
	if applicationContext.Mode == ApplicationModeStandalone {
		data.ServiceWorker = liveServiceWorkerScript()
	}
	var buf bytes.Buffer
	if err := appTmpl.Execute(&buf, data); err != nil {
		return err
	}
	_, err = w.Write(buf.Bytes())
	return err
}
