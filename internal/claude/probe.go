package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"pican/internal/runtimes"
)

type commandRunner func(context.Context, string, []string, []string) ([]byte, error)

func runCommand(ctx context.Context, executable string, args, env []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.Env = env
	return cmd.CombinedOutput()
}

// Probe caches the installed CLI version and authentication state. Catalog
// scans remain independent: native transcripts stay viewable even when the
// CLI is missing or the configured Claude home is logged out.
type Probe struct {
	command string
	home    string
	ttl     time.Duration
	run     commandRunner

	mu           sync.Mutex
	checkedAt    time.Time
	availability runtimes.Availability
	version      string
}

func NewProbe(command, home string, ttl time.Duration) *Probe {
	return newProbe(command, home, ttl, runCommand)
}

func newProbe(command, home string, ttl time.Duration, runner commandRunner) *Probe {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &Probe{command: command, home: home, ttl: ttl, run: runner}
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
	versionOutput, err := p.run(probeCtx, p.command, []string{"--version"}, oauthCommandEnv(p.home))
	if err != nil {
		p.version = ""
		p.availability = runtimes.Availability{Reason: "Claude executable is unavailable: " + commandFailure(err)}
		return
	}
	p.version = normalizeVersion(string(versionOutput))

	authOutput, commandErr := p.run(probeCtx, p.command, []string{"auth", "status", "--json"}, oauthCommandEnv(p.home))
	var status struct {
		LoggedIn bool `json:"loggedIn"`
	}
	decodeErr := json.Unmarshal(authOutput, &status)
	if commandErr != nil {
		// Claude exits non-zero for a valid logged-out status. Prefer the
		// structured result over the generic process error when available.
		if decodeErr == nil && !status.LoggedIn {
			p.availability = runtimes.Availability{Reason: "Claude is not logged in for " + p.home}
			return
		}
		p.availability = runtimes.Availability{Reason: "Claude authentication is unavailable for " + p.home + ": " + commandFailure(commandErr)}
		return
	}
	if decodeErr != nil {
		p.availability = runtimes.Availability{Reason: "Claude authentication status could not be decoded"}
		return
	}
	if !status.LoggedIn {
		p.availability = runtimes.Availability{Reason: "Claude is not logged in for " + p.home}
		return
	}
	p.availability = runtimes.Availability{Available: true}
}

func normalizeVersion(output string) string {
	value := strings.TrimSpace(output)
	value = strings.TrimSuffix(value, " (Claude Code)")
	return strings.TrimSpace(value)
}

func commandFailure(err error) string {
	if err == nil {
		return "unknown error"
	}
	return fmt.Sprint(err)
}
