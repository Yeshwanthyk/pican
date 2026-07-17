package ui

import (
	"strings"
	"testing"
)

func TestChatComposerCSSUsesIntegratedToolbarLayout(t *testing.T) {
	checks := []string{
		".pi-chat-shell",
		".pi-chat-toolbar",
		"border: 1px solid var(--dim);",
		"border-top: none;",
	}
	for _, check := range checks {
		if !strings.Contains(liveSessionCss, check) {
			t.Fatalf("template CSS missing %q; composer should render as an integrated input bar", check)
		}
	}
}
