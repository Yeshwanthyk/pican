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

// runRestart restarts the pican service so the freshly installed binary takes
// over. The restart command is detached into its own session so it survives
// this process being torn down by the service manager. A fallback timer exits
// the process if the service manager does not replace us promptly. On Windows
// there is no service manager: the detached helper waits for this process to
// exit (the fallback timer guarantees that) and then starts the new binary.
func runRestart() error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("sh", "-lc", darwinRestartScript)
	case "linux":
		cmd = exec.Command("systemctl", "--user", "restart", "pican.service")
	case "windows":
		cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", windowsRestartScript())
	default:
		return fmt.Errorf("restart is not supported on %s", runtime.GOOS)
	}
	detachSession(cmd)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start restart command: %w", err)
	}
	// If the service manager doesn't kill us (e.g. it already booted a fresh
	// instance), exit so the old process doesn't linger holding the port.
	time.AfterFunc(5*time.Second, func() { os.Exit(0) })
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
