package server

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"pican/internal/rpc"
	"pican/internal/sessions"
)

func TestSanitizeTitle(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Fix Flaky Login Test", "Fix Flaky Login Test"},
		{"  Fix Flaky Login Test  ", "Fix Flaky Login Test"},
		{"\"Quoted Title\"", "Quoted Title"},
		{"Title\nwith a second line", "Title"},
		// Sanitize enforces the hard title word cap: longer model output is
		// truncated so titles cannot balloon past the limit.
		{"one two three four five six seven", "one two three four"},
		{"one two three four five", "one two three four"},
		{"one two three four", "one two three four"},
		{"", ""},
		{"   ", ""},
		{"`backticked`", "backticked"},
		{`{"title":"Fix Reconnect State."}`, "Fix Reconnect State"},
		{"```json\n{\"title\":\"Fix Reconnect State\"}\n```", "Fix Reconnect State"},
	}
	for _, c := range cases {
		if got := sanitizeTitle(c.in); got != c.want {
			t.Errorf("sanitizeTitle(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestAutoTitlePromptUsesDurableConversationContext(t *testing.T) {
	prompt := autoTitlePrompt(sessions.TitleInputs{
		CurrentName: "Reconnect Bug",
		ConversationText: "USER:\nInvestigate reconnect behavior\n\nASSISTANT:\n" +
			"The stale list appears after the stream reconnects.\n\nUSER:\nFix the synchronization lifecycle",
	})
	for _, want := range []string{
		"Previous title: Reconnect Bug",
		"Investigate reconnect behavior",
		"The stale list appears",
		"Fix the synchronization lifecycle",
		"durable goal",
		// Ported t3code editorial rules must stay in the prompt.
		"Do not copy or truncate a message verbatim",
		"Avoid project names already visible in the UI",
		"Name the product change, not the mock, plan, report, branch, or PR",
		"For reviews, name what is being reviewed and the relevant concern",
		"For research, name the question domain rather than the research process",
		"tools, output formats, and monitoring instructions do not belong in the title",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q: %s", want, prompt)
		}
	}
}

func TestDeriveTitleFromInput(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"   ", ""},
		{"the and for", "The And For"},
		{"add a new feature for the dashboard", "Add New Feature Dashboard"},
		{"fix ```js\nconst x = 1;\n``` bug", "Fix Bug"},
		{"check https://example.com/foo for updates", "Check Updates"},
		{"pican api ui", "Pican API UI"},
	}
	for _, c := range cases {
		if got := deriveTitleFromInput(c.in); got != c.want {
			t.Errorf("deriveTitleFromInput(%q) = %q, want %q", c.in, got, c.want)
		}
	}

	long := "one two three four five six seven eight"
	if got := deriveTitleFromInput(long); len(strings.Fields(got)) > titleWordLimit {
		t.Errorf("deriveTitleFromInput capped at %d words, got %q", titleWordLimit, got)
	}
}

func TestDeriveTitlePreservesMultibyte(t *testing.T) {
	// Burmese (caseless, 3-byte runes) must survive title-casing without being
	// corrupted into U+FFFD replacement characters.
	in := "yolo ဆိုတာ ဘဝ"
	got := deriveTitleFromInput(in)
	if !utf8.ValidString(got) {
		t.Fatalf("title is not valid UTF-8: %q", got)
	}
	if strings.ContainsRune(got, '�') {
		t.Fatalf("title corrupted with replacement chars: %q", got)
	}
	if !strings.Contains(got, "ဆိုတာ") || !strings.Contains(got, "ဘဝ") {
		t.Fatalf("expected Burmese words preserved, got %q", got)
	}
}

// writeSessionFile creates a minimal session JSONL under sessionsDir and returns
// its id (filename). userText="" writes no user message; name!="" adds a
// session_info name line.
func writeAutoTitleSession(t *testing.T, sessionsDir, userText, name string) string {
	t.Helper()
	project := filepath.Join(sessionsDir, "proj")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "2026-06-03T00-00-00.000Z_test.jsonl"
	var b strings.Builder
	b.WriteString(`{"type":"session","version":3,"id":"test","cwd":` + jsonString(project) + `}` + "\n")
	if userText != "" {
		b.WriteString(`{"type":"message","message":{"role":"user","content":"` + userText + `"}}` + "\n")
	}
	if name != "" {
		b.WriteString(`{"type":"session_info","name":"` + name + `"}` + "\n")
	}
	if err := os.WriteFile(filepath.Join(project, id), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return id
}

func newAutoTitleServer(t *testing.T, settings map[string]string) *Server {
	t.Helper()
	s := &Server{
		sessionsDir: t.TempDir(),
		autoTitle: autoTitleState{
			inFlight:  make(map[string]bool),
			name:      make(map[string]string),
			count:     make(map[string]int),
			userOwned: make(map[string]bool),
		},
	}
	if settings != nil {
		s.db = newSettingsTestDB(t)
		for k, v := range settings {
			if _, err := s.db.Exec(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`, k, v); err != nil {
				t.Fatal(err)
			}
		}
	}
	return s
}

func sessionNameNow(t *testing.T, s *Server, id string) string {
	t.Helper()
	resolved, err := sessions.ResolveByID(s.sessionsDir, id)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	return resolved.Session.Name
}

func TestMaybeAutoTitleHeuristicOnce(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:mode": "once"}) // model="" → heuristic
	id := writeAutoTitleSession(t, s.sessionsDir, "fix the flaky login test", "")

	s.maybeAutoTitle(id)

	if got := sessionNameNow(t, s, id); got != "Fix Flaky Login Test" {
		t.Fatalf("expected heuristic title, got %q", got)
	}
	// Second pass is a no-op (already titled once).
	s.maybeAutoTitle(id)
	if got := sessionNameNow(t, s, id); got != "Fix Flaky Login Test" {
		t.Fatalf("title changed on second pass: %q", got)
	}
}

func TestMaybeAutoTitleUsesModel(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:model": "anthropic/sonnet"})
	id := writeAutoTitleSession(t, s.sessionsDir, "fix the flaky login test", "")

	calls := 0
	restore := autoTitleGenerate
	autoTitleGenerate = func(ctx context.Context, opts rpc.PromptOpts) (string, error) {
		calls++
		if opts.Model != "anthropic/sonnet:off" {
			t.Errorf("expected model passed through, got %q", opts.Model)
		}
		return "Model Title", nil
	}
	t.Cleanup(func() { autoTitleGenerate = restore })

	s.maybeAutoTitle(id)
	if got := sessionNameNow(t, s, id); got != "Model Title" {
		t.Fatalf("expected model title, got %q", got)
	}
	s.maybeAutoTitle(id)
	if calls != 1 {
		t.Fatalf("expected model called once (de-dupe), got %d", calls)
	}
}

func TestHostedAutoTitleNeverLaunchesAmbientModelProcess(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:model": "anthropic/sonnet"})
	s.hosted = true
	calls := 0
	restore := autoTitleGenerate
	autoTitleGenerate = func(context.Context, rpc.PromptOpts) (string, error) {
		calls++
		return "must not be used", nil
	}
	t.Cleanup(func() { autoTitleGenerate = restore })

	if got := s.generateTitle("fix the flaky login test"); got != "Fix Flaky Login Test" {
		t.Fatalf("hosted heuristic title = %q", got)
	}
	if calls != 0 {
		t.Fatalf("hosted auto-title launched ambient subprocess %d times", calls)
	}
}

func TestMaybeAutoTitleModelErrorFallsBack(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:model": "anthropic/sonnet"})
	id := writeAutoTitleSession(t, s.sessionsDir, "fix the flaky login test", "")

	restore := autoTitleGenerate
	autoTitleGenerate = func(ctx context.Context, opts rpc.PromptOpts) (string, error) {
		return "", errors.New("model unavailable")
	}
	t.Cleanup(func() { autoTitleGenerate = restore })

	s.maybeAutoTitle(id)
	if got := sessionNameNow(t, s, id); got != "Fix Flaky Login Test" {
		t.Fatalf("expected heuristic fallback, got %q", got)
	}
}

func TestMaybeAutoTitleDoesNotOverwriteManualRenameWhileModelRuns(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:model": "opencode-go/deepseek-v4-flash:off"})
	id := writeAutoTitleSession(t, s.sessionsDir, "investigate reconnect behavior", "")

	started := make(chan struct{})
	release := make(chan struct{})
	restore := autoTitleGenerate
	autoTitleGenerate = func(ctx context.Context, opts rpc.PromptOpts) (string, error) {
		close(started)
		select {
		case <-release:
			return `{"title":"Generated Reconnect Title"}`, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	t.Cleanup(func() { autoTitleGenerate = restore })

	done := make(chan struct{})
	go func() {
		s.maybeAutoTitle(id)
		close(done)
	}()
	<-started

	resolved, err := s.resolveSession(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := sessions.RenameSession(resolved.Path, "Manual Rename", s.now); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done

	if got := sessionNameNow(t, s, id); got != "Manual Rename" {
		t.Fatalf("manual rename was overwritten by stale completion: %q", got)
	}
}

func TestMaybeAutoTitleDisabled(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:enabled": "false"})
	id := writeAutoTitleSession(t, s.sessionsDir, "fix the flaky login test", "")

	s.maybeAutoTitle(id)
	if got := sessionNameNow(t, s, id); got == "Fix Flaky Login Test" {
		t.Fatalf("disabled titling should not rename, got %q", got)
	}
}

func TestMaybeAutoTitleSkipsUserNamed(t *testing.T) {
	s := newAutoTitleServer(t, nil)
	id := writeAutoTitleSession(t, s.sessionsDir, "fix the flaky login test", "My Own Name")

	s.maybeAutoTitle(id)
	if got := sessionNameNow(t, s, id); got != "My Own Name" {
		t.Fatalf("should not clobber user name, got %q", got)
	}
}

func TestMaybeAutoTitleEachTurnUsesLatestMessage(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{
		"pican:v1:auto-title:mode":  "each-turn",
		"pican:v1:auto-title:model": "anthropic/sonnet",
	})
	// Two user messages: each-turn should title from the latest one.
	project := filepath.Join(s.sessionsDir, "proj")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "2026-06-03T00-00-00.000Z_each.jsonl"
	content := `{"type":"session","version":3,"id":"e","cwd":` + jsonString(project) + `}` + "\n" +
		`{"type":"message","message":{"role":"user","content":"first task"}}` + "\n" +
		`{"type":"message","message":{"role":"user","content":"second different task"}}` + "\n"
	if err := os.WriteFile(filepath.Join(project, id), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	var seen string
	restore := autoTitleGenerate
	autoTitleGenerate = func(ctx context.Context, opts rpc.PromptOpts) (string, error) {
		seen = opts.Message
		return "Latest Title", nil
	}
	t.Cleanup(func() { autoTitleGenerate = restore })

	s.maybeAutoTitle(id)
	if !strings.Contains(seen, "second different task") {
		t.Fatalf("each-turn should title from the latest message, prompt was %q", seen)
	}
	if got := sessionNameNow(t, s, id); got != "Latest Title" {
		t.Fatalf("expected 'Latest Title', got %q", got)
	}
}

func TestMaybeAutoTitleReTitlesOwnAutoTitleAcrossRestart(t *testing.T) {
	// A fresh server (empty in-memory maps) seeing a session it previously
	// auto-titled must NOT treat it as user-owned, and should re-title in
	// each-turn mode when a new message has arrived.
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:mode": "each-turn"})
	project := filepath.Join(s.sessionsDir, "proj")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	id := "2026-06-03T00-00-00.000Z_restart.jsonl"
	// Prior auto-title marker + two user messages (a new turn since titling).
	content := `{"type":"session","version":3,"id":"r","cwd":` + jsonString(project) + `}` + "\n" +
		`{"type":"message","message":{"role":"user","content":"old task"}}` + "\n" +
		`{"type":"session_info","name":"Old Task","autoTitle":true}` + "\n" +
		`{"type":"message","message":{"role":"user","content":"brand new request"}}` + "\n"
	if err := os.WriteFile(filepath.Join(project, id), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	s.maybeAutoTitle(id)
	if got := sessionNameNow(t, s, id); got != "Brand New Request" {
		t.Fatalf("expected re-title from new message, got %q", got)
	}
}

func TestMaybeAutoTitleNoUserMessage(t *testing.T) {
	s := newAutoTitleServer(t, nil)
	id := writeAutoTitleSession(t, s.sessionsDir, "", "")

	s.maybeAutoTitle(id) // must not panic or rename
	if got := sessionNameNow(t, s, id); got != id {
		t.Fatalf("expected fallback to filename when no user text, got %q", got)
	}
}

func TestRegenerateTitleOverridesExistingAutoTitle(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:model": "anthropic/sonnet"})
	id := writeAutoTitleSession(t, s.sessionsDir, "investigate reconnect behavior", "")

	calls := 0
	restore := autoTitleGenerate
	autoTitleGenerate = func(ctx context.Context, opts rpc.PromptOpts) (string, error) {
		calls++
		if calls == 1 {
			return "Reconnect Bug", nil
		}
		return "Reconnect Sync Fix", nil
	}
	t.Cleanup(func() { autoTitleGenerate = restore })

	// Automatic pass titles once (default mode is title-once).
	s.maybeAutoTitle(id)
	if got := sessionNameNow(t, s, id); got != "Reconnect Bug" {
		t.Fatalf("expected initial auto title, got %q", got)
	}
	// Another automatic pass is a no-op — already titled.
	s.maybeAutoTitle(id)
	if calls != 1 {
		t.Fatalf("default title-once re-titled on a later pass, model calls = %d", calls)
	}
	// Explicit regenerate forces a fresh model round even though titled.
	s.regenerateTitle(id)
	if got := sessionNameNow(t, s, id); got != "Reconnect Sync Fix" {
		t.Fatalf("expected regenerated title, got %q", got)
	}
	if calls != 2 {
		t.Fatalf("regenerate should run one model call, got %d", calls)
	}
}

func TestRegenerateTitleOverridesManualRename(t *testing.T) {
	s := newAutoTitleServer(t, nil) // default mode (once), heuristic fallback
	id := writeAutoTitleSession(t, s.sessionsDir, "investigate reconnect behavior", "")

	resolved, err := s.resolveSession(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := sessions.RenameSession(resolved.Path, "My Manual Name", s.now); err != nil {
		t.Fatal(err)
	}
	// Automatic titling backs off for good on a user-owned session…
	s.maybeAutoTitle(id)
	if got := sessionNameNow(t, s, id); got != "My Manual Name" {
		t.Fatalf("auto-title clobbered manual name: %q", got)
	}
	// …but an explicit regenerate wins and clears the user-owned mark.
	s.regenerateTitle(id)
	if got := sessionNameNow(t, s, id); got != "Investigate Reconnect Behavior" {
		t.Fatalf("expected regenerated heuristic title, got %q", got)
	}
	// The clear user-owned mark lets a later automatic pass (each-turn mode)
	// treat the session as pican-owned again.
	if s.autoTitle.userOwned[id] {
		t.Fatal("regenerate left userOwned set after writing its own title")
	}
}

func TestRegenerateTitleRequiresUserMessage(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:model": "anthropic/sonnet"})
	id := writeAutoTitleSession(t, s.sessionsDir, "", "Manually Named")

	calls := 0
	restore := autoTitleGenerate
	autoTitleGenerate = func(ctx context.Context, opts rpc.PromptOpts) (string, error) {
		calls++
		return "Should Not Run", nil
	}
	t.Cleanup(func() { autoTitleGenerate = restore })

	s.regenerateTitle(id)
	if calls != 0 {
		t.Fatalf("regenerate ran the model without a user message, calls = %d", calls)
	}
	if got := sessionNameNow(t, s, id); got != "Manually Named" {
		t.Fatalf("regenerate overwrote a session with no user message: %q", got)
	}
}

func TestRegenerateTitleBacksOffOnRacingManualRename(t *testing.T) {
	s := newAutoTitleServer(t, map[string]string{"pican:v1:auto-title:model": "anthropic/sonnet"})
	id := writeAutoTitleSession(t, s.sessionsDir, "investigate reconnect behavior", "")

	started := make(chan struct{})
	release := make(chan struct{})
	restore := autoTitleGenerate
	autoTitleGenerate = func(ctx context.Context, opts rpc.PromptOpts) (string, error) {
		close(started)
		select {
		case <-release:
			return "Stale Regenerated Title", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	t.Cleanup(func() { autoTitleGenerate = restore })

	done := make(chan struct{})
	go func() {
		s.regenerateTitle(id)
		close(done)
	}()
	<-started

	resolved, err := s.resolveSession(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := sessions.RenameSession(resolved.Path, "Faster Manual Name", s.now); err != nil {
		t.Fatal(err)
	}
	close(release)
	<-done

	if got := sessionNameNow(t, s, id); got != "Faster Manual Name" {
		t.Fatalf("regenerate overwrote a manual rename made while it ran: %q", got)
	}
}
