// Package workspace validates paths against a single hosted workspace root.
package workspace

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var (
	ErrOutsideRoot = errors.New("path is outside workspace root")
	ErrTraversal   = errors.New("path traversal is not allowed")
)

// Resolver holds a canonical, symlink-resolved workspace root.
type Resolver struct {
	root string
}

// New constructs a resolver for an existing directory.
func New(root string) (*Resolver, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("workspace root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace root: %w", err)
	}
	info, err := os.Stat(canonical)
	if err != nil {
		return nil, fmt.Errorf("stat workspace root: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("workspace root must be a directory")
	}
	return &Resolver{root: filepath.Clean(canonical)}, nil
}

func (r *Resolver) Root() string {
	if r == nil {
		return ""
	}
	return r.root
}

// ResolveExisting canonicalizes an existing path and accepts only the root or
// one of its descendants. Both the root and candidate are symlink-resolved.
func (r *Resolver) ResolveExisting(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("path is required")
	}
	if hasTraversal(path) {
		return "", ErrTraversal
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	canonical = filepath.Clean(canonical)
	if !r.contains(canonical) {
		return "", ErrOutsideRoot
	}
	return canonical, nil
}

// ResolveForCreation validates a path that may not exist yet. It rejects
// traversal lexically, resolves the nearest existing ancestor through
// symlinks, appends only validated missing components, and then re-checks
// containment. It does not create the path.
func (r *Resolver) ResolveForCreation(path string) (string, error) {
	raw := strings.TrimSpace(path)
	if raw == "" {
		return "", errors.New("path is required")
	}
	if hasTraversal(raw) {
		return "", ErrTraversal
	}
	absolute, err := filepath.Abs(raw)
	if err != nil {
		return "", err
	}
	absolute = filepath.Clean(absolute)

	ancestor := absolute
	var suffix []string
	for {
		_, statErr := os.Lstat(ancestor)
		if statErr == nil {
			break
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return "", statErr
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", statErr
		}
		component := filepath.Base(ancestor)
		if component == "" || component == "." || component == ".." {
			return "", ErrTraversal
		}
		suffix = append(suffix, component)
		ancestor = parent
	}

	canonicalAncestor, err := filepath.EvalSymlinks(ancestor)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(canonicalAncestor)
	if err != nil {
		return "", err
	}
	if !info.IsDir() && len(suffix) > 0 {
		return "", errors.New("nearest existing ancestor is not a directory")
	}
	candidate := filepath.Clean(canonicalAncestor)
	for i := len(suffix) - 1; i >= 0; i-- {
		candidate = filepath.Join(candidate, suffix[i])
	}
	if !r.contains(candidate) {
		return "", ErrOutsideRoot
	}
	return candidate, nil
}

// CreateDir validates, creates, and resolves a directory. The final resolution
// catches a symlink swap or unexpected existing link before callers use it.
func (r *Resolver) CreateDir(path string, mode os.FileMode) (string, error) {
	candidate, err := r.ResolveForCreation(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(r.root, candidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrOutsideRoot
	}
	root, err := os.OpenRoot(r.root)
	if err != nil {
		return "", err
	}
	defer root.Close()
	if err := root.MkdirAll(rel, mode); err != nil {
		return "", err
	}
	return r.ResolveExisting(candidate)
}

func (r *Resolver) contains(path string) bool {
	return Contains(r.root, path)
}

// Contains reports whether path is root or a lexical descendant. Callers that
// accept untrusted paths should canonicalize both operands first.
func Contains(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func hasTraversal(path string) bool {
	volume := filepath.VolumeName(path)
	path = strings.TrimPrefix(path, volume)
	for _, component := range strings.FieldsFunc(path, func(r rune) bool {
		return r == '/' || r == '\\'
	}) {
		if component == ".." {
			return true
		}
	}
	return false
}
