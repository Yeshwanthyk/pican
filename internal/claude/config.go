package claude

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const (
	CommandEnv = "PICAN_CLAUDE_COMMAND"
	HomeEnv    = "PICAN_CLAUDE_HOME"
	ConfigEnv  = "CLAUDE_CONFIG_DIR"
)

// ResolveCommand applies CLI, pican environment, then PATH precedence.
func ResolveCommand(flagValue string) string {
	if value := strings.TrimSpace(flagValue); value != "" {
		return value
	}
	if value := strings.TrimSpace(os.Getenv(CommandEnv)); value != "" {
		return value
	}
	return "claude"
}

// ResolveHome returns the effective Claude config root. Claude stores native
// project transcripts below <home>/projects. The native default remains
// implicit because explicitly setting CLAUDE_CONFIG_DIR=~/.claude selects a
// separate credential profile in Claude Code.
func ResolveHome(flagValue string) (string, error) {
	value := strings.TrimSpace(flagValue)
	if value == "" {
		value = strings.TrimSpace(os.Getenv(HomeEnv))
	}
	if value == "" {
		value = strings.TrimSpace(os.Getenv(ConfigEnv))
	}
	if value == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		value = filepath.Join(home, ".claude")
	}
	if value == "~" || strings.HasPrefix(value, "~"+string(filepath.Separator)) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if value == "~" {
			value = home
		} else {
			value = filepath.Join(home, strings.TrimPrefix(value, "~"+string(filepath.Separator)))
		}
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	absolute = filepath.Clean(absolute)
	if absolute == "." || absolute == "" {
		return "", errors.New("Claude home is required")
	}
	return absolute, nil
}

func commandEnv(home string) []string {
	env := withoutEnvironmentKey(os.Environ(), ConfigEnv)
	if isDefaultHome(home) {
		return env
	}
	return append(env, ConfigEnv+"="+home)
}

func isDefaultHome(home string) bool {
	userHome, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	defaultHome := filepath.Join(userHome, ".claude")
	return filepath.Clean(home) == filepath.Clean(defaultHome)
}

// oauthCommandEnv keeps availability probes and workers on the configured
// Claude home's OAuth identity. An inherited API key takes precedence in the
// CLI, so allowing it in only one path can probe as logged in and then fail the
// first turn (or silently cross the configured work/personal auth boundary).
func oauthCommandEnv(home string) []string {
	return withoutEnvironmentKey(commandEnv(home), "ANTHROPIC_API_KEY")
}

func withoutEnvironmentKey(env []string, key string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		if !strings.EqualFold(name, key) {
			out = append(out, entry)
		}
	}
	return out
}
