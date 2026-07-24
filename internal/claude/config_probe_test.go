package claude

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestResolveCommandAndHomePrecedence(t *testing.T) {
	t.Setenv(CommandEnv, "/env/claude")
	if got := ResolveCommand("/flag/claude"); got != "/flag/claude" {
		t.Fatalf("flag command = %q", got)
	}
	if got := ResolveCommand(""); got != "/env/claude" {
		t.Fatalf("environment command = %q", got)
	}
	t.Setenv(HomeEnv, filepath.Join(t.TempDir(), "pican-home"))
	t.Setenv(ConfigEnv, filepath.Join(t.TempDir(), "native-home"))
	flagHome := filepath.Join(t.TempDir(), "flag-home")
	if got, err := ResolveHome(flagHome); err != nil || got != flagHome {
		t.Fatalf("flag home = %q, %v", got, err)
	}
	if got, err := ResolveHome(""); err != nil || got != filepath.Clean(strings.TrimSpace(os.Getenv(HomeEnv))) {
		t.Fatalf("pican home = %q, %v", got, err)
	}
	t.Setenv(HomeEnv, "")
	if got, err := ResolveHome(""); err != nil || got != filepath.Clean(strings.TrimSpace(os.Getenv(ConfigEnv))) {
		t.Fatalf("Claude config home = %q, %v", got, err)
	}
}

func TestResolveHomeExpandsBareTilde(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	got, err := ResolveHome("~")
	if err != nil || got != filepath.Clean(home) {
		t.Fatalf("bare tilde home = %q, %v; want %q", got, err, filepath.Clean(home))
	}
}

func TestProbeUsesConfiguredHomeAndCachesAvailability(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "stale-key-must-not-override-home-auth")
	var calls [][]string
	runner := func(_ context.Context, executable string, args, env []string) ([]byte, error) {
		calls = append(calls, append([]string{executable}, args...))
		foundHome := false
		for _, entry := range env {
			foundHome = foundHome || entry == ConfigEnv+"=/explicit/claude home"
		}
		if !foundHome {
			t.Fatalf("configured home missing from environment: %v", env)
		}
		for _, entry := range env {
			if strings.HasPrefix(strings.ToUpper(entry), "ANTHROPIC_API_KEY=") {
				t.Fatalf("inherited API key crossed configured-home auth boundary: %v", env)
			}
		}
		if reflect.DeepEqual(args, []string{"--version"}) {
			return []byte("2.1.215 (Claude Code)\n"), nil
		}
		return []byte(`{"loggedIn":true}`), nil
	}
	probe := newProbe("/path with spaces/claude", "/explicit/claude home", time.Hour, runner)
	status := probe.Availability(context.Background())
	if !status.Available || status.Reason != "" || probe.Version() != "2.1.215" {
		t.Fatalf("probe = %+v version=%q", status, probe.Version())
	}
	_ = probe.Availability(context.Background())
	if len(calls) != 2 || !reflect.DeepEqual(calls[0], []string{"/path with spaces/claude", "--version"}) || !reflect.DeepEqual(calls[1], []string{"/path with spaces/claude", "auth", "status", "--json"}) {
		t.Fatalf("probe argv/caching = %v", calls)
	}
}

func TestOAuthCommandEnvReplacesHomeAndRemovesCaseInsensitiveAPIKey(t *testing.T) {
	t.Setenv(ConfigEnv, "/wrong/home")
	t.Setenv("ANTHROPIC_API_KEY", "stale")
	t.Setenv("anthropic_api_key", "duplicate")
	env := oauthCommandEnv("/right/home")
	var homes int
	for _, entry := range env {
		if entry == ConfigEnv+"=/right/home" {
			homes++
		}
		if strings.EqualFold(strings.SplitN(entry, "=", 2)[0], "ANTHROPIC_API_KEY") {
			t.Fatalf("API key survived: %v", env)
		}
	}
	if homes != 1 {
		t.Fatalf("configured home entries = %d, env=%v", homes, env)
	}
}

func TestOAuthCommandEnvLeavesNativeDefaultProfileImplicit(t *testing.T) {
	userHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(ConfigEnv, "/wrong/home")
	t.Setenv("ANTHROPIC_API_KEY", "stale")
	env := oauthCommandEnv(filepath.Join(userHome, ".claude"))
	for _, entry := range env {
		name := strings.SplitN(entry, "=", 2)[0]
		if strings.EqualFold(name, ConfigEnv) || strings.EqualFold(name, "ANTHROPIC_API_KEY") {
			t.Fatalf("default-profile override survived: %v", env)
		}
	}
}

func TestProbeReportsExecutableAndAuthenticationFailures(t *testing.T) {
	missing := newProbe("claude", "/home", time.Hour, func(context.Context, string, []string, []string) ([]byte, error) {
		return nil, errors.New("not found")
	})
	if status := missing.Availability(context.Background()); status.Available || !strings.Contains(status.Reason, "executable is unavailable") {
		t.Fatalf("missing executable status = %+v", status)
	}

	loggedOut := newProbe("claude", "/home", time.Hour, func(_ context.Context, _ string, args, _ []string) ([]byte, error) {
		if reflect.DeepEqual(args, []string{"--version"}) {
			return []byte("2.1.215"), nil
		}
		return []byte(`{"loggedIn":false}`), errors.New("exit status 1")
	})
	if status := loggedOut.Availability(context.Background()); status.Available || status.Reason != "Claude is not logged in for /home" {
		t.Fatalf("logged-out status = %+v", status)
	}
}

func TestModelsUseClaudeAliases(t *testing.T) {
	models := Models()
	if len(models) != 3 || models[0].ID != "sonnet" || models[1].ID != "opus" || models[2].ID != "haiku" {
		t.Fatalf("models = %+v", models)
	}
	for _, model := range models {
		if model.Provider != Provider || model.Model != model.ID || model.DisplayName == "" {
			t.Fatalf("model = %+v", model)
		}
	}
}
