package server

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"pican/internal/sessions"
	"pican/internal/workspace"
)

var errSessionOutsideWorkspace = errors.New("session working directory is outside the hosted workspace")

func (s *Server) resolveWorkspacePath(path string) (string, error) {
	if s.workspace == nil {
		return path, nil
	}
	resolved, err := s.workspace.ResolveExisting(path)
	if err != nil {
		return "", fmt.Errorf("%w: %v", errSessionOutsideWorkspace, err)
	}
	return resolved, nil
}

func (s *Server) resolveWorkspaceLeaf(path string) (string, error) {
	if s.workspace == nil {
		return path, nil
	}
	resolved, err := s.workspace.ResolveExisting(path)
	if errors.Is(err, os.ErrNotExist) {
		resolved, err = s.workspace.ResolveForCreation(path)
	}
	if err != nil {
		return "", fmt.Errorf("%w: %v", errSessionOutsideWorkspace, err)
	}
	return resolved, nil
}

// prepareSessionPath is the creation boundary shared by server-owned session
// creation flows. handleNewSession uses the same package-level seam.
func (s *Server) prepareSessionPath(path string) (string, error) {
	if s.workspace == nil {
		return sessions.PrepareSessionPath(path)
	}
	return sessions.PrepareSessionPathInWorkspace(path, s.workspaceRoot)
}

func (s *Server) createPiSession(path string, settings sessions.InitialSettings) (string, error) {
	if s.workspace == nil {
		return sessions.CreateSessionFileWithSettings(s.sessionsDir, path, settings)
	}
	return sessions.CreateSessionFileWithSettingsInWorkspace(s.sessionsDir, path, s.workspaceRoot, settings)
}

func (s *Server) validateSessionWorkspace(resolved sessions.ResolvedSession) (string, error) {
	cwd, _ := resolved.Session.Header["cwd"].(string)
	if strings.TrimSpace(cwd) == "" {
		return "", errors.New("session working directory is missing")
	}
	return s.resolveWorkspacePath(cwd)
}

func (s *Server) workspaceProject(path string) (string, bool) {
	if strings.TrimSpace(path) == "" {
		return "", false
	}
	resolved, err := s.resolveWorkspacePath(path)
	return resolved, err == nil
}

// validateGitBoundary finds the repository metadata Git would discover from
// cwd and proves that its real path remains inside the hosted workspace. This
// rejects both .git symlinks and worktree gitfiles that target an outer repo.
func (s *Server) validateGitBoundary(cwd string) error {
	if s.workspace == nil {
		return nil
	}
	dir, err := s.workspace.ResolveExisting(cwd)
	if err != nil {
		return fmt.Errorf("%w: %v", errSessionOutsideWorkspace, err)
	}
	for {
		dotGit := filepath.Join(dir, ".git")
		info, statErr := os.Lstat(dotGit)
		switch {
		case statErr == nil && info.IsDir():
			_, err = s.workspace.ResolveExisting(dotGit)
			if err != nil {
				return fmt.Errorf("%w: git metadata: %v", errSessionOutsideWorkspace, err)
			}
			return nil
		case statErr == nil && info.Mode()&os.ModeSymlink != 0:
			_, err = s.workspace.ResolveExisting(dotGit)
			if err != nil {
				return fmt.Errorf("%w: git metadata: %v", errSessionOutsideWorkspace, err)
			}
			return nil
		case statErr == nil && info.Mode().IsRegular():
			data, readErr := os.ReadFile(dotGit)
			if readErr != nil {
				return fmt.Errorf("read git metadata: %w", readErr)
			}
			line := strings.TrimSpace(string(data))
			const prefix = "gitdir:"
			if !strings.HasPrefix(strings.ToLower(line), prefix) {
				return errors.New("invalid .git file")
			}
			target := strings.TrimSpace(line[len(prefix):])
			if !filepath.IsAbs(target) {
				target = filepath.Join(dir, target)
			}
			if _, err = s.workspace.ResolveExisting(target); err != nil {
				return fmt.Errorf("%w: git metadata: %v", errSessionOutsideWorkspace, err)
			}
			return nil
		case statErr != nil && !errors.Is(statErr, os.ErrNotExist):
			return fmt.Errorf("inspect git metadata: %w", statErr)
		case statErr == nil:
			return errors.New("invalid git metadata")
		}

		if dir == s.workspaceRoot {
			return nil
		}
		parent := filepath.Dir(dir)
		if parent == dir || !workspace.Contains(s.workspaceRoot, parent) {
			return nil
		}
		dir = parent
	}
}

func isWorkspaceBoundaryError(err error) bool {
	return errors.Is(err, errSessionOutsideWorkspace) ||
		errors.Is(err, workspace.ErrOutsideRoot) ||
		errors.Is(err, workspace.ErrTraversal)
}
