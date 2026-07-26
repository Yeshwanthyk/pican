package server

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// browseEntry is a single directory suggestion returned by GET /api/fs/browse.
type browseEntry struct {
	Name     string `json:"name"`
	FullPath string `json:"fullPath"`
}

// maxBrowseEntries caps how many directory suggestions a single browse
// request returns, so a huge directory never blows up the response.
const maxBrowseEntries = 200

var errBrowsePathNotAbsolute = errors.New("path must be absolute")

// handleFSBrowse powers the New Session directory picker: given the path the
// user is currently typing, it lists sibling/child directories so the
// frontend can render a browse-as-you-type dropdown. Directories only — a
// session path is always a directory.
func (s *Server) handleFSBrowse(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	raw := r.URL.Query().Get("path")
	if s.workspace != nil && strings.TrimSpace(raw) == "" {
		raw = s.workspaceRoot + string(filepath.Separator)
	}
	expanded, err := expandBrowsePath(raw)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if s.workspace != nil {
		expanded, err = s.workspace.ResolveForCreation(expanded)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	parent, filter := splitBrowsePath(expanded)
	if s.workspace != nil {
		parent, err = s.workspace.ResolveExisting(parent)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	info, statErr := os.Stat(expanded)
	exists := statErr == nil && info.IsDir()
	entries := listBrowseDirs(parent, filter)
	if s.workspace != nil {
		contained := entries[:0]
		for _, entry := range entries {
			resolved, resolveErr := s.workspace.ResolveExisting(entry.FullPath)
			if resolveErr != nil {
				continue
			}
			entry.FullPath = resolved
			contained = append(contained, entry)
		}
		entries = contained
	}

	writeJSON(w, 0, map[string]any{
		"parentPath": parent,
		"entries":    entries,
		"exists":     exists,
	})
}

// expandBrowsePath expands a leading "~" (home directory), defaults an empty
// path to the user's home, and rejects anything that is still not absolute
// after expansion — no relative-path browsing.
func expandBrowsePath(raw string) (string, error) {
	path := raw
	if path == "" {
		path = "~/"
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = home + path[1:]
	}
	if !filepath.IsAbs(path) {
		return "", errBrowsePathNotAbsolute
	}
	return path, nil
}

// splitBrowsePath separates the typed (expanded) path into the directory to
// list (parent) and the case-insensitive prefix filter applied to its
// entries. A trailing slash means "list this directory itself, no filter";
// otherwise the last path segment is a partial name to filter siblings by.
func splitBrowsePath(path string) (parent, filter string) {
	if strings.HasSuffix(path, "/") {
		return filepath.Clean(path), ""
	}
	return filepath.Dir(path), filepath.Base(path)
}

// listBrowseDirs lists directories under parent whose name case-insensitively
// starts with filter. Hidden directories (leading dot) are included only when
// filter itself starts with a dot. Any ReadDir failure — missing parent,
// permission denied (EACCES/EPERM), or otherwise — yields an empty list
// rather than an error: a picker should degrade quietly, not break on an
// unreadable or not-yet-created directory. Results are sorted by name and
// capped at maxBrowseEntries.
func listBrowseDirs(parent, filter string) []browseEntry {
	dirents, err := os.ReadDir(parent)
	if err != nil {
		return []browseEntry{}
	}

	showHidden := strings.HasPrefix(filter, ".")
	lowerFilter := strings.ToLower(filter)

	out := make([]browseEntry, 0, len(dirents))
	for _, d := range dirents {
		if !d.IsDir() {
			continue
		}
		name := d.Name()
		if !showHidden && strings.HasPrefix(name, ".") {
			continue
		}
		if !strings.HasPrefix(strings.ToLower(name), lowerFilter) {
			continue
		}
		out = append(out, browseEntry{Name: name, FullPath: filepath.Join(parent, name)})
	}
	sort.Slice(out, func(i, j int) bool {
		li, lj := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if li != lj {
			return li < lj
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > maxBrowseEntries {
		out = out[:maxBrowseEntries]
	}
	return out
}
