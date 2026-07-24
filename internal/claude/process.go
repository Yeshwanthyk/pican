package claude

import (
	"io"
	"os/exec"
)

// ProcessSpec is an argv-only Claude process launch. Command is never passed
// through a shell.
type ProcessSpec struct {
	Command string
	Args    []string
	Env     []string
	Dir     string
}

// Process is the injectable lifecycle boundary used by Worker. Tests provide
// deterministic in-memory processes; production uses exec.Cmd.
type Process interface {
	Start() error
	Wait() error
	Stdin() io.WriteCloser
	Stdout() io.Reader
	Stderr() io.Reader
	PID() int
	ExitCode() int
	Kill() error
}

type ProcessFactory func(ProcessSpec) (Process, error)

type execProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser
}

func newExecProcess(spec ProcessSpec) (Process, error) {
	cmd := exec.Command(spec.Command, spec.Args...)
	configureClaudeCommand(cmd)
	cmd.Env = append([]string(nil), spec.Env...)
	cmd.Dir = spec.Dir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, err
	}
	return &execProcess{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr}, nil
}

func (p *execProcess) Start() error          { return p.cmd.Start() }
func (p *execProcess) Wait() error           { return p.cmd.Wait() }
func (p *execProcess) Stdin() io.WriteCloser { return p.stdin }
func (p *execProcess) Stdout() io.Reader     { return p.stdout }
func (p *execProcess) Stderr() io.Reader     { return p.stderr }
func (p *execProcess) Kill() error           { return killClaudeCommand(p.cmd) }
func (p *execProcess) ExitCode() int {
	if p.cmd.ProcessState == nil {
		return -1
	}
	return p.cmd.ProcessState.ExitCode()
}
func (p *execProcess) PID() int {
	if p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}
