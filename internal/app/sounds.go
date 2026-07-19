package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"pican/internal/agentdir"
	"pican/internal/ui"
)

// seedSoundsDir ensures that ~/.pi/agent/pican/assets exists and seeds it with default sounds if empty.
func seedSoundsDir(agentDir string) error {
	soundsDir := filepath.Join(agentdir.PicanDir(agentDir), "assets")
	if err := os.MkdirAll(soundsDir, 0755); err != nil {
		return fmt.Errorf("failed to create sounds directory: %w", err)
	}

	files, err := os.ReadDir(soundsDir)
	if err != nil {
		return fmt.Errorf("failed to read sounds directory: %w", err)
	}

	hasMP3 := false
	for _, f := range files {
		if !f.IsDir() && filepath.Ext(strings.ToLower(f.Name())) == ".mp3" {
			hasMP3 = true
			break
		}
	}

	if !hasMP3 {
		// Seed cat.mp3
		catPath := filepath.Join(soundsDir, "cat.mp3")
		if err := os.WriteFile(catPath, ui.CatMP3, 0644); err != nil {
			return fmt.Errorf("failed to seed cat.mp3: %w", err)
		}
		// Seed done.mp3
		donePath := filepath.Join(soundsDir, "done.mp3")
		if err := os.WriteFile(donePath, ui.DoneMP3, 0644); err != nil {
			return fmt.Errorf("failed to seed done.mp3: %w", err)
		}
	}
	return nil
}
