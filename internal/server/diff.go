package server

import (
	"net/http"

	"pi-web/internal/git"
)

// handleGitDiff returns the uncommitted working-tree diff (tracked changes plus
// untracked files) for the session's cwd, along with the current branch.
func (s *Server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	_, cwd, err := s.resolveSessionCwd(r.URL.Query().Get("id"))
	if resolveOrWriteError(w, err) {
		return
	}
	diff, err := git.WorkingTreeDiff(cwd)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"isRepo": false, "diff": ""})
		return
	}
	branch, _ := git.CurrentBranch(cwd)
	writeJSON(w, http.StatusOK, map[string]any{"isRepo": true, "diff": diff, "branch": branch})
}
