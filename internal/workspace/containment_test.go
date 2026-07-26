package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestResolverExistingContainment(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	child := filepath.Join(root, "project")
	sibling := filepath.Join(parent, "sibling")
	for _, path := range []string{child, sibling} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	resolver, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{root, child} {
		got, err := resolver.ResolveExisting(path)
		want, _ := filepath.EvalSymlinks(path)
		if err != nil || got != want {
			t.Fatalf("ResolveExisting(%q) = %q, %v", path, got, err)
		}
	}
	inRootTraversal := child + string(filepath.Separator) + ".."
	if _, err := resolver.ResolveExisting(inRootTraversal); !errors.Is(err, ErrTraversal) {
		t.Fatalf("ResolveExisting with in-root traversal error = %v, want ErrTraversal", err)
	}
	outsideTraversal := root + string(filepath.Separator) + ".." + string(filepath.Separator) + "sibling"
	if _, err := resolver.ResolveExisting(outsideTraversal); !errors.Is(err, ErrTraversal) {
		t.Fatalf("ResolveExisting traversal error = %v, want ErrTraversal", err)
	}
	if _, err := resolver.ResolveExisting(sibling); !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("ResolveExisting sibling error = %v, want ErrOutsideRoot", err)
	}
}

func TestResolverRejectsSymlinkEscape(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "workspace")
	outside := filepath.Join(parent, "outside")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	resolver, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.ResolveExisting(link); !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("existing symlink error = %v, want ErrOutsideRoot", err)
	}
	if _, err := resolver.ResolveForCreation(filepath.Join(link, "new")); !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("creation symlink error = %v, want ErrOutsideRoot", err)
	}
	if _, err := resolver.CreateDir(filepath.Join(link, "created"), 0o755); !errors.Is(err, ErrOutsideRoot) {
		t.Fatalf("create symlink error = %v, want ErrOutsideRoot", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "created")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("CreateDir wrote through escaping symlink: %v", err)
	}
}

func TestResolverCreatesSafeMissingChild(t *testing.T) {
	root := filepath.Join(t.TempDir(), "workspace")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	resolver, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(root, "one", "two")
	got, err := resolver.CreateDir(missing, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if got != missing {
		want, _ := filepath.EvalSymlinks(missing)
		if got != want {
			t.Fatalf("CreateDir = %q, want %q", got, want)
		}
	}
	if info, err := os.Stat(missing); err != nil || !info.IsDir() {
		t.Fatalf("created directory = %v, %v", info, err)
	}
	traversal := root + string(filepath.Separator) + "one" + string(filepath.Separator) + ".." + string(filepath.Separator) + "three"
	if _, err := resolver.ResolveForCreation(traversal); !errors.Is(err, ErrTraversal) {
		t.Fatalf("traversal error = %v, want ErrTraversal", err)
	}
}
