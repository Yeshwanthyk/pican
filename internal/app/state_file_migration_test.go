package app

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteStateFile_SkipsMigrationWhenNewExists(t *testing.T) {
	tmp := t.TempDir()
	picanDir := filepath.Join(tmp, "pican")
	oldPath := filepath.Join(tmp, "pican-state.json")
	newPath := filepath.Join(picanDir, "pican-state.json")

	// Simulate another instance already holding the new path
	if err := os.MkdirAll(picanDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oldPath, []byte(`{"pid":123}`), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newPath, []byte(`{"pid":999}`), 0644); err != nil {
		t.Fatal(err)
	}

	path, err := writeStateFile(tmp, "127.0.0.1", "31415", false, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if stateFile != nil {
			_ = stateFile.Close()
			stateFile = nil
		}
	}()

	if path != newPath {
		t.Fatalf("expected new path %s, got %s", newPath, path)
	}
	// Old file should still exist (migration was skipped)
	if _, err := os.Stat(oldPath); err != nil {
		t.Fatal("old state file should still exist when new already present")
	}
}

func TestWriteStateFile_MigratesOldStateFile(t *testing.T) {
	tmp := t.TempDir()
	oldPath := filepath.Join(tmp, "pican-state.json")
	newPath := filepath.Join(tmp, "pican", "pican-state.json")

	// Create old state file
	if err := os.WriteFile(oldPath, []byte(`{"pid":123}`), 0644); err != nil {
		t.Fatal(err)
	}

	path, err := writeStateFile(tmp, "127.0.0.1", "31415", false, "")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if stateFile != nil {
			_ = stateFile.Close()
			stateFile = nil
		}
	}()

	if path != newPath {
		t.Fatalf("expected new path %s, got %s", newPath, path)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatal("old state file should have been moved")
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("new state file should exist: %v", err)
	}
}
