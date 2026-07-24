package opencode

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CanonicalDirectory resolves the directory identity OpenCode uses to scope
// every project/session request. In particular, it resolves macOS /tmp to
// /private/tmp so response validation does not reject the same directory under
// two filesystem aliases.
func CanonicalDirectory(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("OpenCode directory is required")
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("OpenCode directory must be absolute: %q", path)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("resolve OpenCode directory %q: %w", path, err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("stat OpenCode directory %q: %w", resolved, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("OpenCode directory is not a directory: %q", resolved)
	}
	return filepath.Clean(resolved), nil
}

func validateScopedDirectory(expected, actual string) (string, error) {
	expectedCanonical, err := CanonicalDirectory(expected)
	if err != nil {
		return "", err
	}
	actualCanonical, err := CanonicalDirectory(actual)
	if err != nil {
		return "", err
	}
	if expectedCanonical != actualCanonical {
		return "", fmt.Errorf("OpenCode session directory mismatch: requested %q, received %q", expectedCanonical, actualCanonical)
	}
	return actualCanonical, nil
}
