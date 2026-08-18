package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"pican/internal/updater"
)

// releaseResolver is the subset of updater.Checker the install path needs.
// Defined here so the update tests can stub the GitHub Releases API with a
// scripted fake instead of a live checker.
type releaseResolver interface {
	LatestAsset(ctx context.Context, platform string) (tag, assetName, downloadURL string, err error)
	LatestChecksumsURL(ctx context.Context) (string, error)
}

// updateHTTPClient downloads the binary and checksum assets. The caller's
// context (server handleUpdate gives it 5 minutes) bounds the whole install;
// this timeout only bounds each individual request.
var updateHTTPClient = &http.Client{Timeout: 10 * time.Minute}

// runInstall downloads the latest pican binary from GitHub Releases for the
// platform pican is running on, verifies its sha256 checksum when the release
// ships one, atomically replaces the running binary, and leaves the restart
// to the caller (server handleUpdate → runRestart).
func runInstall(ctx context.Context, checker *updater.Checker) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate pican binary: %w", err)
	}
	return installUpdate(ctx, checker, exe)
}

// installUpdate is runInstall's testable core: it replaces exePath with the
// latest release binary for the current platform.
func installUpdate(ctx context.Context, checker releaseResolver, exePath string) error {
	platform := runtime.GOOS + "-" + runtime.GOARCH
	tag, assetName, downloadURL, err := checker.LatestAsset(ctx, platform)
	if err != nil {
		return fmt.Errorf("resolve latest pican release: %w", err)
	}

	// Stage the download next to the running binary so the final rename is a
	// pure rename(2) on the same filesystem (a temp dir like /tmp can live on
	// a different mount and would fail with EXDEV).
	dir := filepath.Dir(exePath)
	tmp, err := os.CreateTemp(dir, ".pican-update-*")
	if err != nil {
		return fmt.Errorf("create staging file in %s: %w", dir, err)
	}
	defer func() {
		tmp.Close()
		_ = os.Remove(tmp.Name())
	}()

	if err := downloadTo(ctx, downloadURL, tmp); err != nil {
		return fmt.Errorf("download %s (%s): %w", assetName, tag, err)
	}
	if err := tmp.Chmod(0o755); err != nil {
		return fmt.Errorf("chmod staging binary: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("finalize staging binary: %w", err)
	}

	// Verify the checksum when the release includes sha256sums.txt; proceed
	// with a warning when it doesn't (parity with install.sh, which never
	// verifies).
	sumURL, err := checker.LatestChecksumsURL(ctx)
	if err != nil {
		return fmt.Errorf("resolve checksum asset: %w", err)
	}
	if sumURL != "" {
		if err := verifyChecksum(ctx, sumURL, assetName, tmp.Name()); err != nil {
			return fmt.Errorf("checksum verification failed for %s: %w", assetName, err)
		}
	} else {
		fmt.Fprintf(os.Stderr, "WARNING: release %s has no sha256sums.txt asset; skipping checksum verification\n", tag)
	}

	// Atomic replace: Unix semantics allow renaming over a running executable.
	if err := os.Rename(tmp.Name(), exePath); err != nil {
		return fmt.Errorf("replace %s: %w", exePath, err)
	}
	return nil
}

// downloadTo streams url into dst.
func downloadTo(ctx context.Context, url string, dst io.Writer) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "pican-updater")
	resp, err := updateHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	_, err = io.Copy(dst, resp.Body)
	return err
}

// verifyChecksum downloads the release's sha256sums.txt and fails unless it
// lists a matching sha256 for assetName. Missing entries for the asset are
// treated as a mismatch (fail closed); callers decide what to do when the
// checksum asset itself is absent.
func verifyChecksum(ctx context.Context, sumURL, assetName, file string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sumURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "pican-updater")
	resp, err := updateHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", sumURL, resp.StatusCode)
	}
	sums, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}

	want, err := checksumForAsset(string(sums), assetName)
	if err != nil {
		return err
	}
	got, err := fileSHA256(file)
	if err != nil {
		return err
	}
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("sha256 mismatch: want %s, got %s", want, got)
	}
	return nil
}

// checksumForAsset finds the expected sha256 hex digest for assetName in
// standard sha256sum output (hash + filename per line, either column order of
// name separators accepted). A missing entry is an error.
func checksumForAsset(sums, assetName string) (string, error) {
	for _, line := range strings.Split(sums, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		var hash, name string
		if len(fields[0]) == 64 {
			hash, name = fields[0], fields[1]
		} else if len(fields[1]) == 64 {
			hash, name = fields[1], fields[0]
		} else {
			continue
		}
		name = strings.TrimPrefix(name, "./")
		name = strings.TrimPrefix(name, "*")
		if name == assetName {
			return hash, nil
		}
	}
	return "", fmt.Errorf("sha256sums.txt has no entry for %s", assetName)
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Restart timing knobs. All three are variables only in the sense that the
// fallback seam (spawnReexec/exitProcess/exitAfter below) is injectable for
// tests; production uses these constants.
const (
	// serviceRestartTimeout bounds how long we wait for the service manager
	// (launchd/systemd) to finish restarting the service before deciding it
	// failed.
	serviceRestartTimeout = 3 * time.Second
	// reexecDelay is how long the re-exec fallback child sleeps before
	// binding, so the old process can exit and release the port first.
	reexecDelay = 1 * time.Second
	// exitDelay is how long we keep running after handing the restart to the
	// service manager (or to the Windows helper). If nobody replaces us by
	// then, exit so the old process doesn't linger holding the port.
	exitDelay = 5 * time.Second
)

// spawnReexec launches the detached re-exec child. It is a package var so
// tests can capture the command instead of spawning a real process.
var spawnReexec = func(cmd *exec.Cmd) error { return cmd.Start() }

// exitProcess terminates this process. It is a package var so tests can
// observe the fallback path without killing the test binary.
var exitProcess = os.Exit

// exitAfter arms the timer that exits the process if the service manager does
// not replace it. It is a package var so tests can observe the timer.
var exitAfter = func(d time.Duration) *time.Timer {
	return time.AfterFunc(d, func() { exitProcess(0) })
}

// runRestart restarts pican so the freshly installed binary takes over. On
// darwin/linux it asks the service manager (launchd/systemd) to restart the
// service, running that command synchronously with a short timeout: when it
// succeeds the service manager replaces this process and an exit timer covers
// the case where it boots a fresh instance that needs the port. When it fails
// (non-zero exit — a bare binary run with no launchd plist or systemd unit)
// the binary is re-executed as a detached child and this process exits
// immediately, so manual-run instances come back too. On Windows there is no
// service manager: the detached helper waits for this process to exit (the
// exit timer guarantees that) and then starts the new binary.
func runRestart() error {
	switch runtime.GOOS {
	case "windows":
		return windowsRestart()
	default:
		runner, err := newServiceRunner(runtime.GOOS)
		if err != nil {
			return err
		}
		return unixRestart(runner)
	}
}

// restartRunner is the seam for the service-manager restart command. Tests
// script success/failure through it instead of shelling out.
type restartRunner interface {
	// restartService runs the service-manager restart command and reports
	// whether the service manager took over (true) or the command failed
	// (false, e.g. no launchd plist or systemd unit). A non-nil error means
	// the command could not be run at all.
	restartService() (tookOver bool, err error)
}

// unixServiceRunner runs the platform's service-manager restart command
// synchronously, bounded by serviceRestartTimeout.
type unixServiceRunner struct {
	cmd *exec.Cmd
}

// newServiceRunner builds the detached service-manager restart command for
// goos (darwin: launchd via the shell script; linux: systemd user unit).
func newServiceRunner(goos string) (restartRunner, error) {
	var cmd *exec.Cmd
	switch goos {
	case "darwin":
		cmd = exec.Command("sh", "-lc", darwinRestartScript)
	case "linux":
		cmd = exec.Command("systemctl", "--user", "restart", "pican.service")
	default:
		return nil, fmt.Errorf("restart is not supported on %s", goos)
	}
	detachSession(cmd)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return &unixServiceRunner{cmd: cmd}, nil
}

func (u *unixServiceRunner) restartService() (tookOver bool, err error) {
	if err := u.cmd.Start(); err != nil {
		return false, fmt.Errorf("failed to start restart command: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- u.cmd.Wait() }()
	select {
	case err := <-done:
		// Exit 0: the service manager handled the restart. A non-zero exit
		// (e.g. the launchd script's `exit 127` without a plist, or systemctl
		// failing without a unit) means this is a bare binary run: fall back
		// to re-exec.
		return err == nil, nil
	case <-time.After(serviceRestartTimeout):
		// A slow command means a service manager is present but taking its
		// time; killing it mid-flight could leave the service half-restarted
		// and a re-exec child would then race the manager's replacement
		// instance for the port. Treat it as a (slow) take-over and rely on
		// the exit timer, matching the pre-fallback behavior.
		_ = u.cmd.Process.Kill()
		<-done
		return true, nil
	}
}

// unixRestart decides how a darwin/linux process hands over to the newly
// installed binary: the service manager replaces us (arm the exit timer), or
// the service manager is absent and we re-exec the binary in a detached child
// and exit immediately.
func unixRestart(runner restartRunner) error {
	tookOver, err := runner.restartService()
	if err != nil {
		return err
	}
	if tookOver {
		// If the service manager doesn't kill us (e.g. it already booted a
		// fresh instance), exit so the old process doesn't linger holding the
		// port.
		exitAfter(exitDelay)
		return nil
	}
	// No service manager: re-exec the binary in a detached child that sleeps
	// long enough for this process to exit and release the port.
	cmd, err := reexecCommand()
	if err != nil {
		return err
	}
	if err := spawnReexec(cmd); err != nil {
		return err
	}
	// The /api/restart response was flushed before runRestart was invoked;
	// exit now so the child can bind the port.
	exitProcess(0)
	return nil
}

// reexecCommand builds the detached re-exec command: a shell that sleeps for
// reexecDelay so this process can release the port, then execs the current
// binary with the same argv, cwd, and env.
func reexecCommand() (*exec.Cmd, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("locate pican binary for re-exec: %w", err)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("locate working directory for re-exec: %w", err)
	}
	argv := make([]string, 0, len(os.Args))
	for _, a := range os.Args[1:] {
		argv = append(argv, shQuote(a))
	}
	script := fmt.Sprintf("sleep %d; exec %s %s",
		int(reexecDelay/time.Second), shQuote(exe), strings.Join(argv, " "))
	cmd := exec.Command("sh", "-c", script)
	detachSession(cmd)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s for re-exec stdio: %w", os.DevNull, err)
	}
	cmd.Stdin = devnull
	cmd.Stdout = devnull
	cmd.Stderr = os.Stderr
	return cmd, nil
}

// shQuote quotes s as a single shell word. Single quotes are escaped the
// standard POSIX way so arbitrary argv (paths with spaces or quotes) survive
// the round-trip through sh.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// windowsRestart relaunches pican on Windows. There is no service manager:
// the detached PowerShell helper waits for this process to exit (the exit
// timer guarantees that) and then starts the new binary through the hidden
// startup launcher, falling back to the bare executable for manual installs.
func windowsRestart() error {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", windowsRestartScript())
	detachSession(cmd)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start restart command: %w", err)
	}
	exitAfter(exitDelay)
	return nil
}

// windowsRestartScript builds the PowerShell body of the detached restart
// helper: wait for this process to release the port, then relaunch through the
// hidden startup launcher written by install.ps1, falling back to the bare
// executable for manual installs.
func windowsRestartScript() string {
	psQuote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	exe, _ := os.Executable()
	home, _ := os.UserHomeDir()
	launcher := filepath.Join(home, ".config", "pican", "pican-start.vbs")
	return fmt.Sprintf(
		"Wait-Process -Id %d -Timeout 30 -ErrorAction SilentlyContinue; "+
			"if (Test-Path %s) { Start-Process wscript.exe -ArgumentList %s } else { Start-Process %s }",
		os.Getpid(), psQuote(launcher), psQuote(`"`+launcher+`"`), psQuote(exe))
}

// darwinRestartScript mirrors the extension's `/pican restart`: re-bootstrap
// the launchd job, preserving the PICAN_TOKEN from the env file, then kick it.
const darwinRestartScript = `plist="$HOME/Library/LaunchAgents/com.pican.plist"
if [ ! -f "$plist" ]; then exit 127; fi
env_file="$HOME/.config/pican/env"
token="$(awk -F= '$1 == "PICAN_TOKEN" { sub(/^[^=]*=/, ""); print; exit }' "$env_file" 2>/dev/null || true)"
if [ -n "$token" ]; then
  launchctl setenv PICAN_TOKEN "$token" 2>/dev/null || true
fi
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
launchctl kickstart -k "gui/$(id -u)/com.pican" 2>/dev/null || launchctl start com.pican`
