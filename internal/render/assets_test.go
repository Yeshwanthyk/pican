package render

import "testing"

func TestAssetManifestScriptPath(t *testing.T) {
	manifest := Manifest{
		"src/index/index.js": ManifestEntry{File: "assets/index-abc123.js"},
	}
	got, ok := manifest.ScriptPath("src/index/index.js")
	if !ok {
		t.Fatalf("expected script path to be found")
	}
	if got != "/static/assets/index-abc123.js" {
		t.Fatalf("script path = %q", got)
	}
}

func TestAssetManifestMissingScript(t *testing.T) {
	manifest := Manifest{}
	if got, ok := manifest.ScriptPath("missing.js"); ok || got != "" {
		t.Fatalf("missing script = %q, %v; want empty false", got, ok)
	}
}
