package opencode

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCanonicalDirectoryResolvesAliasesAndRejectsUnsafeInputs(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(real, alias); err != nil {
		t.Fatal(err)
	}

	got, err := CanonicalDirectory(alias)
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("canonical directory = %q, want %q", got, want)
	}
	for _, invalid := range []string{"", "relative", filepath.Join(root, "missing")} {
		if _, err := CanonicalDirectory(invalid); err == nil {
			t.Fatalf("CanonicalDirectory(%q) succeeded", invalid)
		}
	}
}

func TestValidateScopedDirectoryRejectsCrossDirectoryResponse(t *testing.T) {
	left := t.TempDir()
	right := t.TempDir()
	if _, err := validateScopedDirectory(left, right); err == nil {
		t.Fatal("cross-directory response was accepted")
	}
}
