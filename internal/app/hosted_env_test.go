package app

import (
	"slices"
	"testing"
)

func TestHostedCodexChildEnvKeepsOnlySafeProcessAndSentinelValues(t *testing.T) {
	got := hostedCodexChildEnv([]string{
		"PATH=/usr/bin",
		"HOME=/workspace/demo",
		"CODEX_HOME=/workspace/demo/.codex",
		"OPENAI_API_KEY=opaque-codex-sentinel",
		"GH_TOKEN=opaque-github-sentinel",
		"GITHUB_TOKEN=old",
		"GITHUB_TOKEN=opaque-github-sentinel",
		"PICAN_PROXY_TOKEN=proxy-secret-fixture",
		"PICAN_TOKEN=pican-secret-fixture",
		"SCOTTY_REAL_CREDENTIAL=real-secret-fixture",
		"CLOUDFLARE_API_TOKEN=real-secret-fixture",
		"AWS_SECRET_ACCESS_KEY=real-secret-fixture",
		"UNRELATED=drop-me",
	})
	want := []string{
		"PATH=/usr/bin",
		"HOME=/workspace/demo",
		"CODEX_HOME=/workspace/demo/.codex",
		"OPENAI_API_KEY=opaque-codex-sentinel",
		"GH_TOKEN=opaque-github-sentinel",
		"GITHUB_TOKEN=opaque-github-sentinel",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("hostedCodexChildEnv() = %q, want %q", got, want)
	}
}

func TestHostedCodexChildEnvNeverMutatesInput(t *testing.T) {
	input := []string{"PATH=/first", "PATH=/last", "PICAN_PROXY_TOKEN=secret"}
	original := slices.Clone(input)
	_ = hostedCodexChildEnv(input)
	if !slices.Equal(input, original) {
		t.Fatalf("input mutated: got %q, want %q", input, original)
	}
}
