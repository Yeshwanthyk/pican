//go:build windows

package claude

import (
	"os/exec"
	"strconv"
)

func configureClaudeCommand(_ *exec.Cmd) {}

func killClaudeCommand(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	if err := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid)).Run(); err == nil {
		return nil
	}
	return cmd.Process.Kill()
}
