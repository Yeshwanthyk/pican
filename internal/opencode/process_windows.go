//go:build windows

package opencode

import (
	"os/exec"
	"strconv"
)

func configureOpenCodeCommand(_ *exec.Cmd) {}

func killOpenCodeCommand(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	if err := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(command.Process.Pid)).Run(); err == nil {
		return nil
	}
	return command.Process.Kill()
}
