package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestExpandBrowsePath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	abs := filepath.Join(t.TempDir(), "proj")

	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{"empty defaults to home", "", home + "/", false},
		{"bare tilde expands to home", "~", home, false},
		{"tilde slash expands under home", "~/proj", filepath.Join(home, "proj"), false},
		{"already absolute", abs, abs, false},
		{"relative path rejected", "relative/path", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := expandBrowsePath(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expandBrowsePath(%q) expected error, got %q", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("expandBrowsePath(%q) unexpected error: %v", tc.in, err)
			}
			if got != tc.want {
				t.Fatalf("expandBrowsePath(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSplitBrowsePath(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		wantParent string
		wantFilter string
	}{
		{"trailing slash is a directory with no filter", "/Users/x/", "/Users/x", ""},
		{"root with trailing slash", "/", "/", ""},
		{"partial last segment is the filter", "/Users/x/pro", "/Users/x", "pro"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parent, filter := splitBrowsePath(tc.in)
			if parent != tc.wantParent || filter != tc.wantFilter {
				t.Fatalf("splitBrowsePath(%q) = (%q, %q), want (%q, %q)", tc.in, parent, filter, tc.wantParent, tc.wantFilter)
			}
		})
	}
}

func mkdirs(t *testing.T, root string, names ...string) {
	t.Helper()
	for _, name := range names {
		if err := os.Mkdir(filepath.Join(root, name), 0755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
}

func TestListBrowseDirs_PrefixFilterCaseInsensitive(t *testing.T) {
	root := t.TempDir()
	mkdirs(t, root, "web", "Website", "internal", "docs")
	if err := os.WriteFile(filepath.Join(root, "webfile.txt"), []byte("x"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	got := listBrowseDirs(root, "we")
	var names []string
	for _, e := range got {
		names = append(names, e.Name)
	}
	want := []string{"web", "Website"}
	if len(names) != len(want) {
		t.Fatalf("listBrowseDirs names = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("listBrowseDirs names = %v, want %v", names, want)
		}
	}
	for _, e := range got {
		if e.FullPath != filepath.Join(root, e.Name) {
			t.Fatalf("entry %q has wrong fullPath %q", e.Name, e.FullPath)
		}
	}
}

func TestListBrowseDirs_HiddenOnlyWhenFilterStartsWithDot(t *testing.T) {
	root := t.TempDir()
	mkdirs(t, root, ".git", ".config", "visible")

	withoutDot := listBrowseDirs(root, "")
	for _, e := range withoutDot {
		if e.Name == ".git" || e.Name == ".config" {
			t.Fatalf("hidden dir %q leaked into unfiltered listing %v", e.Name, withoutDot)
		}
	}

	withDot := listBrowseDirs(root, ".")
	names := map[string]bool{}
	for _, e := range withDot {
		names[e.Name] = true
	}
	if !names[".git"] || !names[".config"] {
		t.Fatalf("expected hidden dirs when filter starts with '.', got %v", withDot)
	}
	if names["visible"] {
		t.Fatalf("expected non-hidden dir to be excluded when filter is '.', got %v", withDot)
	}
}

func TestListBrowseDirs_PermissionErrorSwallowed(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: permission bits are not enforced")
	}
	root := t.TempDir()
	locked := filepath.Join(root, "locked")
	if err := os.Mkdir(locked, 0000); err != nil {
		t.Fatalf("mkdir locked: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0755) })

	got := listBrowseDirs(locked, "")
	if len(got) != 0 {
		t.Fatalf("expected empty entries for unreadable dir, got %v", got)
	}
}

func TestListBrowseDirs_MissingParentSwallowed(t *testing.T) {
	got := listBrowseDirs(filepath.Join(t.TempDir(), "does-not-exist"), "")
	if len(got) != 0 {
		t.Fatalf("expected empty entries for missing parent, got %v", got)
	}
}

func TestListBrowseDirs_CapAtMax(t *testing.T) {
	root := t.TempDir()
	names := make([]string, 0, maxBrowseEntries+25)
	for i := 0; i < maxBrowseEntries+25; i++ {
		names = append(names, fmt.Sprintf("dir%04d", i))
	}
	mkdirs(t, root, names...)

	got := listBrowseDirs(root, "")
	if len(got) != maxBrowseEntries {
		t.Fatalf("listBrowseDirs returned %d entries, want cap of %d", len(got), maxBrowseEntries)
	}
}

func TestHandleFSBrowse(t *testing.T) {
	s := &Server{}
	root := t.TempDir()
	mkdirs(t, root, "web", "internal")

	req := httptest.NewRequest(http.MethodGet, "/api/fs/browse?path="+root+"/", nil)
	w := httptest.NewRecorder()
	s.handleFSBrowse(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var body struct {
		ParentPath string        `json:"parentPath"`
		Entries    []browseEntry `json:"entries"`
		Exists     bool          `json:"exists"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.ParentPath != filepath.Clean(root) {
		t.Fatalf("parentPath = %q, want %q", body.ParentPath, filepath.Clean(root))
	}
	if !body.Exists {
		t.Fatalf("expected exists=true for %q", root+"/")
	}
	if len(body.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %v", body.Entries)
	}
}

func TestHandleFSBrowse_NonExistentPathReportsExistsFalse(t *testing.T) {
	s := &Server{}
	missing := filepath.Join(t.TempDir(), "not-yet-created")

	req := httptest.NewRequest(http.MethodGet, "/api/fs/browse?path="+missing, nil)
	w := httptest.NewRecorder()
	s.handleFSBrowse(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var body struct {
		Exists  bool          `json:"exists"`
		Entries []browseEntry `json:"entries"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Exists {
		t.Fatalf("expected exists=false for a path that doesn't exist yet")
	}
}

func TestHandleFSBrowse_RelativePathRejected(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodGet, "/api/fs/browse?path=relative/path", nil)
	w := httptest.NewRecorder()
	s.handleFSBrowse(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", w.Code, w.Body.String())
	}
}

func TestHandleFSBrowse_MethodNotAllowed(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/api/fs/browse", nil)
	w := httptest.NewRecorder()
	s.handleFSBrowse(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}
