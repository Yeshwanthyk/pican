package app

import (
	"bytes"
	"slices"
	"testing"
)

func TestParseCLIHostedEnvironmentContract(t *testing.T) {
	workspaceRoot := t.TempDir()
	stateRoot := workspaceRoot + "/.pican"
	t.Setenv(modeEnvVar, string(ModeHosted))
	t.Setenv(basePathEnvVar, "/s/test")
	t.Setenv(workspaceEnvVar, workspaceRoot)
	t.Setenv(stateRootEnvVar, stateRoot)
	t.Setenv(authModeEnvVar, string(AuthModeProxy))
	t.Setenv(proxyHeaderEnvVar, "X-Scotty-Pican")
	t.Setenv(proxyTokenEnvVar, "proxy-secret-fixture")
	t.Setenv("CODEX_SENTINEL", "opaque-codex-sentinel")
	t.Setenv("GITHUB_TOKEN", "opaque-github-sentinel")
	t.Setenv("SCOTTY_REAL_CREDENTIAL", "real-secret-fixture")

	config, showVersion, err := ParseCLI([]string{"-runtime=codex"}, "test", &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if showVersion {
		t.Fatal("showVersion = true")
	}
	if config.Mode != ModeHosted || config.AuthMode != AuthModeProxy ||
		config.BasePath != "/s/test" || config.WorkspaceRoot != workspaceRoot ||
		config.StateRoot != stateRoot || config.ProxyAuthHeader != "X-Scotty-Pican" ||
		config.AuthToken != "proxy-secret-fixture" {
		t.Fatalf("hosted config = %+v", config)
	}
	if !slices.Contains(config.ChildEnv, "CODEX_SENTINEL=opaque-codex-sentinel") ||
		!slices.Contains(config.ChildEnv, "GITHUB_TOKEN=opaque-github-sentinel") {
		t.Fatalf("hosted child env lacks sentinels: %q", config.ChildEnv)
	}
	for _, forbidden := range []string{
		"PICAN_PROXY_TOKEN=proxy-secret-fixture",
		"SCOTTY_REAL_CREDENTIAL=real-secret-fixture",
	} {
		if slices.Contains(config.ChildEnv, forbidden) {
			t.Fatalf("hosted child env leaked %q", forbidden)
		}
	}
}

func TestParseCLIHasNoProxyTokenFlag(t *testing.T) {
	_, _, err := ParseCLI([]string{"-proxy-token=secret"}, "test", &bytes.Buffer{})
	if err == nil {
		t.Fatal("ParseCLI accepted a proxy token command-line flag")
	}
}
