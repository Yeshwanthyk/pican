package ui

import (
	"os"
	"strings"
	"testing"
)

// Navigating from the tree must never leave it stuck over the chat. In the
// live app the tree is a FullScreenSheet overlay that closes via closeTree()
// on every viewport; the static export keeps the docked drawer, whose mobile
// close-on-navigate lives in sidebar.ts + export-entry.ts. Assert against the
// source.
func TestMobileSidebarClosesWhenNavigatingTree(t *testing.T) {
	sidebarSrc, err := os.ReadFile(repoPath("web/src/session/ui/sidebar.ts"))
	if err != nil {
		t.Fatalf("read sidebar.ts: %v", err)
	}
	liveTreeSrc, err := os.ReadFile(repoPath("web/src/components/session/SessionTree.svelte"))
	if err != nil {
		t.Fatalf("read SessionTree.svelte: %v", err)
	}
	exportSrc, err := os.ReadFile(repoPath("web/src/export/export-entry.ts"))
	if err != nil {
		t.Fatalf("read export-entry.ts: %v", err)
	}
	sidebarChecks := []string{
		"export function setSidebarOpen(",
		"open: boolean,",
		`documentImpl.body?.classList.toggle("sidebar-open", open);`,
	}
	for _, check := range sidebarChecks {
		if !strings.Contains(string(sidebarSrc), check) {
			t.Fatalf("sidebar.ts missing %q; mobile sidebar can remain stuck over chat", check)
		}
	}
	if !strings.Contains(string(liveTreeSrc), "closeTree()") {
		t.Fatal("SessionTree.svelte missing close-on-navigate; tree overlay can remain stuck over chat")
	}
	if !strings.Contains(string(exportSrc), "ui.closeSidebar()") {
		t.Fatal("export-entry.ts missing mobile close-on-navigate; sidebar can remain stuck over chat")
	}
}

func TestMobileSessionActionsStayAtTopAndHideBehindSidebar(t *testing.T) {
	checks := []string{
		`class="session-header-bar export-only"`,
		"@media (max-width: 900px)",
		".session-header-bar {",
		"position: fixed;",
		"top: 0;",
	}
	combined := liveSessionCss + exportSessionHtml + exportJs
	for _, check := range checks {
		if !strings.Contains(combined, check) {
			t.Fatalf("mobile action UI missing %q", check)
		}
	}
	// The unified header bar should use top positioning, not bottom.
	cssAfterMobile := liveSessionCss[strings.Index(liveSessionCss, "@media (max-width: 900px)"):]
	headerIdx := strings.Index(cssAfterMobile, ".session-header-bar")
	if headerIdx == -1 {
		t.Fatalf("missing .session-header-bar in mobile media query")
	}
	blockIdx := strings.Index(cssAfterMobile[headerIdx:], "}")
	if blockIdx == -1 {
		t.Fatalf("unclosed .session-header-bar block in mobile media query")
	}
	headerBlock := cssAfterMobile[headerIdx : headerIdx+blockIdx+1]
	if strings.Contains(headerBlock, "\nbottom:") && !strings.Contains(headerBlock, "\nbottom: auto") {
		t.Fatalf("mobile header bar should use top positioning, not bottom, to avoid overlapping chat composer")
	}
}

func TestMobileSessionActionsDoNotCoverHeaderToggleButtons(t *testing.T) {
	checks := []string{
		"padding: calc(52px + env(safe-area-inset-top) + 8px)",
		".header-toggle-btn",
		"data-action=\"toggle-thinking\"",
		"data-action=\"toggle-tools\"",
	}
	combined := liveSessionCss + exportJs
	for _, check := range checks {
		if !strings.Contains(combined, check) {
			t.Fatalf("mobile session header controls missing %q; fixed session actions can cover toggle buttons", check)
		}
	}
}

func TestMobileGitFooterHidesPullRequestActions(t *testing.T) {
	mobileRule := "@media (max-width: 900px) {\n  /* Keep the compact branch context on phones; PR workflow actions\n         belong in the roomier desktop footer. */\n  .pi-git-pr {\n    display: none;\n  }\n}"
	if !strings.Contains(liveSessionCss, mobileRule) {
		t.Fatal("mobile session footer must hide PR actions")
	}
}
