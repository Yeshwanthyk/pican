package ui

import (
	"regexp"
	"strings"
	"testing"
)

var namedThemeIDs = []string{
	"dark", "light", "nord", "dracula",
	"catppuccin-mocha", "catppuccin-latte", "gruvbox-dark", "tokyo-night", "rose-pine",
	"github-dark", "github-light", "one-dark-pro", "everforest-dark", "kanagawa-wave",
}

var themeTokenPattern = regexp.MustCompile(`--([A-Za-z0-9-]+)\s*:`)

func themeTokens(t *testing.T, css, theme string) map[string]bool {
	t.Helper()
	selector := `[data-theme="` + theme + `"] {`
	start := strings.Index(css, selector)
	if start == -1 {
		t.Fatalf("theme.css missing selector %s", selector)
	}
	body := css[start+len(selector):]
	end := strings.Index(body, "\n}")
	if end == -1 {
		t.Fatalf("theme.css has unterminated block for %s", theme)
	}
	tokens := make(map[string]bool)
	for _, match := range themeTokenPattern.FindAllStringSubmatch(body[:end], -1) {
		tokens[match[1]] = true
	}
	return tokens
}

func TestNamedThemesImplementCompleteTokenContract(t *testing.T) {
	want := themeTokens(t, liveThemeCss, "dark")
	if len(want) == 0 {
		t.Fatal("dark theme defines no tokens")
	}

	for _, theme := range namedThemeIDs[1:] {
		t.Run(theme, func(t *testing.T) {
			got := themeTokens(t, liveThemeCss, theme)
			for token := range want {
				if !got[token] {
					t.Errorf("missing --%s", token)
				}
			}
			for token := range got {
				if !want[token] {
					t.Errorf("unexpected --%s; add it to every named theme", token)
				}
			}
		})
	}
}

func TestRouteStylesDoNotOwnNamedThemePalettes(t *testing.T) {
	if strings.Contains(appStylesBundle, `[data-theme="`) {
		t.Fatal("route stylesheet bundle declares a named theme; palettes belong only in theme.css")
	}
	if strings.Contains(appStylesBundle, "--body-bg:") {
		t.Fatal("route stylesheet bundle redeclares palette tokens; palettes belong only in theme.css")
	}
}

func TestBootThemeRegistryIncludesEveryNamedTheme(t *testing.T) {
	boot := string(themeBootScript("dark"))
	for _, theme := range namedThemeIDs {
		if !strings.Contains(boot, "'"+theme+"'") {
			t.Errorf("boot theme registry missing %q", theme)
		}
	}
}
