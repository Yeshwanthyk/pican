package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"pican/internal/agentdir"
)

// stateFile is held open for the lifetime of the process so the flock stays
// in effect. Closing it releases the lock.
var stateFile *os.File

func writeStateFile(agentDir, host, port string, tailscale bool, tailscaleURL string) (string, error) {
	picanDir := agentdir.PicanDir(agentDir)
	if err := os.MkdirAll(picanDir, 0755); err != nil {
		return "", err
	}
	path := filepath.Join(picanDir, "pican-state.json")

	// Migrate old state file from pre-pican directory layout.
	// Only migrate when the new path does not already exist; otherwise
	// os.Rename would unlink a destination inode that another pican
	// process may already hold a flock on, defeating the single-instance
	// lock.
	oldPath := filepath.Join(agentDir, "pican-state.json")
	if _, err := os.Stat(oldPath); err == nil {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			_ = os.Rename(oldPath, path)
		}
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return "", err
	}
	if err := lockStateFile(f); err != nil {
		_ = f.Close()
		return "", err
	}
	data, err := json.Marshal(map[string]any{
		"pid":          os.Getpid(),
		"port":         port,
		"host":         host,
		"tailscale":    tailscale,
		"tailscaleUrl": tailscaleURL,
		"startedAt":    time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		_ = f.Close()
		return "", err
	}
	if err := f.Truncate(0); err != nil {
		_ = f.Close()
		return "", err
	}
	if _, err := f.WriteAt(data, 0); err != nil {
		_ = f.Close()
		return "", err
	}
	stateFile = f
	return path, nil
}
