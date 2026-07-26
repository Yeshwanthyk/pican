package codex

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"pican/internal/runtimes"
)

type probeRunner func(context.Context, string, ...string) ([]byte, error)

func runProbeCommand(ctx context.Context, executable string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, executable, args...).CombinedOutput()
}

func runProbeCommandWithOptions(options ProcessOptions) probeRunner {
	options = options.clone()
	return func(ctx context.Context, executable string, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, executable, args...)
		if options.Env != nil {
			cmd.Env = options.Env
		}
		if options.Dir != "" {
			cmd.Dir = options.Dir
		}
		return cmd.CombinedOutput()
	}
}

// Probe keeps executable/auth health separate from catalog freshness. A large
// native catalog may take time to reconcile without making app-server unusable
// for create, resume, or chat operations.
type Probe struct {
	command string
	ttl     time.Duration
	run     probeRunner

	mu           sync.Mutex
	checkedAt    time.Time
	availability runtimes.Availability
	version      string
}

func NewProbe(command string, ttl time.Duration) *Probe {
	return newProbe(command, ttl, runProbeCommand)
}

func NewProbeWithOptions(command string, ttl time.Duration, options ProcessOptions) *Probe {
	return newProbe(command, ttl, runProbeCommandWithOptions(options))
}

func newProbe(command string, ttl time.Duration, runner probeRunner) *Probe {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Probe{command: command, ttl: ttl, run: runner}
}

func (p *Probe) Availability(ctx context.Context) runtimes.Availability {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.checkedAt.IsZero() || time.Since(p.checkedAt) >= p.ttl {
		p.refreshLocked(ctx)
	}
	return p.availability
}

func (p *Probe) Refresh(ctx context.Context) runtimes.Availability {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.refreshLocked(ctx)
	return p.availability
}

func (p *Probe) Version() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.version
}

func (p *Probe) refreshLocked(ctx context.Context) {
	p.checkedAt = time.Now()
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	versionOutput, err := p.run(probeCtx, p.command, "--version")
	if err != nil {
		p.version = ""
		p.availability = runtimes.Availability{Reason: "Codex executable is unavailable: " + probeFailure(err, versionOutput)}
		return
	}
	p.version = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(versionOutput)), "codex-cli "))

	authOutput, err := p.run(probeCtx, p.command, "login", "status")
	if err != nil {
		p.availability = runtimes.Availability{Reason: "Codex authentication is unavailable: " + probeFailure(err, authOutput)}
		return
	}
	p.availability = runtimes.Availability{Available: true}
}

func probeFailure(err error, output []byte) string {
	message := strings.TrimSpace(string(output))
	if message != "" {
		return message
	}
	return fmt.Sprint(err)
}
