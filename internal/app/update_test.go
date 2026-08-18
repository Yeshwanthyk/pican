package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"pican/internal/updater"
)

// fakeServiceRunner scripts the service-manager restart command: success
// (tookOver), failure (bare-binary run), or a hard error.
type fakeServiceRunner struct {
	tookOver bool
	err      error
	calls    int
}

func (f *fakeServiceRunner) restartService() (tookOver bool, err error) {
	f.calls++
	return f.tookOver, f.err
}

// setRestartHooks swaps the restart seams (re-exec spawn, process exit, exit
// timer) for the duration of the test so the fallback decision can be
// observed without spawning processes or killing the test binary.
func setRestartHooks(t *testing.T, spawn func(*exec.Cmd) error, exit func(int), timer func(time.Duration) *time.Timer) {
	t.Helper()
	origSpawn, origExit, origTimer := spawnReexec, exitProcess, exitAfter
	spawnReexec, exitProcess, exitAfter = spawn, exit, timer
	t.Cleanup(func() {
		spawnReexec, exitProcess, exitAfter = origSpawn, origExit, origTimer
	})
}

func TestRunRestartServiceManagerSuccessArmsExitTimer(t *testing.T) {
	runner := &fakeServiceRunner{tookOver: true}
	var spawned []*exec.Cmd
	exited := false
	timerArmed := false
	setRestartHooks(t,
		func(cmd *exec.Cmd) error { spawned = append(spawned, cmd); return nil },
		func(code int) { exited = true },
		func(d time.Duration) *time.Timer { timerArmed = true; return time.NewTimer(time.Hour) },
	)

	if err := unixRestart(runner); err != nil {
		t.Fatalf("unixRestart err: %v", err)
	}
	if runner.calls != 1 {
		t.Errorf("service runner invoked %d times, want 1", runner.calls)
	}
	if len(spawned) != 0 {
		t.Errorf("re-exec child spawned %d times, want 0", len(spawned))
	}
	if !timerArmed {
		t.Errorf("exit timer was not armed after service-manager success")
	}
	if exited {
		t.Errorf("process exited despite service-manager success")
	}
}

func TestRunRestartServiceManagerFailureReexecs(t *testing.T) {
	runner := &fakeServiceRunner{tookOver: false}
	var spawned *exec.Cmd
	exited := false
	timerArmed := false
	setRestartHooks(t,
		func(cmd *exec.Cmd) error { spawned = cmd; return nil },
		func(code int) { exited = true },
		func(d time.Duration) *time.Timer { timerArmed = true; return time.NewTimer(time.Hour) },
	)

	if err := unixRestart(runner); err != nil {
		t.Fatalf("unixRestart err: %v", err)
	}
	if runner.calls != 1 {
		t.Errorf("service runner invoked %d times, want 1", runner.calls)
	}
	if spawned == nil {
		t.Fatal("re-exec child was not spawned")
	}
	if timerArmed {
		t.Errorf("exit timer armed in re-exec fallback path")
	}
	if !exited {
		t.Errorf("old process did not exit after spawning re-exec child")
	}

	// The child must preserve the runtime: same executable and argv
	// (shell-quoted inside the detached sh -c script), same cwd and env, in a
	// detached session, with a sleep so the old process releases the port
	// before the child binds.
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if len(spawned.Args) != 3 || spawned.Args[0] != "sh" || spawned.Args[1] != "-c" {
		t.Fatalf("re-exec command = %q, want sh -c <script>", spawned.Args)
	}
	quoted := make([]string, 0, len(os.Args))
	for _, a := range os.Args[1:] {
		quoted = append(quoted, shQuote(a))
	}
	wantScript := fmt.Sprintf("sleep 1; exec %s %s", shQuote(exe), strings.Join(quoted, " "))
	if spawned.Args[2] != wantScript {
		t.Errorf("re-exec script = %q, want %q", spawned.Args[2], wantScript)
	}
	if cwd, _ := os.Getwd(); spawned.Dir != cwd {
		t.Errorf("re-exec cwd = %q, want %q", spawned.Dir, cwd)
	}
	if !slices.Equal(spawned.Env, os.Environ()) {
		t.Errorf("re-exec env does not match the parent env")
	}
	if spawned.SysProcAttr == nil {
		t.Errorf("re-exec child is not detached (no SysProcAttr)")
	}
	if spawned.Stdin == nil || spawned.Stdout == nil {
		t.Errorf("re-exec stdio is not detached")
	}
}

func TestRunRestartServiceRunnerErrorPropagates(t *testing.T) {
	runner := &fakeServiceRunner{err: errors.New("restart command could not start")}
	var spawned *exec.Cmd
	exited := false
	timerArmed := false
	setRestartHooks(t,
		func(cmd *exec.Cmd) error { spawned = cmd; return nil },
		func(code int) { exited = true },
		func(d time.Duration) *time.Timer { timerArmed = true; return time.NewTimer(time.Hour) },
	)

	err := unixRestart(runner)
	if err == nil {
		t.Fatal("expected runner error to propagate")
	}
	if spawned != nil || exited || timerArmed {
		t.Errorf("no child/timer/exit expected on runner error: spawned=%v exited=%v timerArmed=%v",
			spawned != nil, exited, timerArmed)
	}
}

func TestRunRestartReexecSpawnFailurePropagates(t *testing.T) {
	runner := &fakeServiceRunner{tookOver: false}
	exited := false
	setRestartHooks(t,
		func(cmd *exec.Cmd) error { return errors.New("spawn boom") },
		func(code int) { exited = true },
		func(d time.Duration) *time.Timer { return time.NewTimer(time.Hour) },
	)

	err := unixRestart(runner)
	if err == nil || !strings.Contains(err.Error(), "spawn boom") {
		t.Fatalf("expected spawn error to propagate, got: %v", err)
	}
	if exited {
		t.Errorf("process exited despite spawn failure")
	}
}

func TestUnixServiceRunnerMapsExitStatus(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix service runner is not used on windows")
	}
	// Exit 0 means the service manager took over.
	ok := &unixServiceRunner{cmd: exec.Command("true")}
	tookOver, err := ok.restartService()
	if err != nil {
		t.Fatalf("restartService err: %v", err)
	}
	if !tookOver {
		t.Errorf("exit 0 reported as not taken over")
	}
	// Non-zero exit (e.g. launchd script exits 127 without a plist) means a
	// bare binary run: fall back to re-exec.
	fail := &unixServiceRunner{cmd: exec.Command("false")}
	tookOver, err = fail.restartService()
	if err != nil {
		t.Fatalf("restartService err: %v", err)
	}
	if tookOver {
		t.Errorf("non-zero exit reported as taken over")
	}
}

func TestUnixServiceRunnerTimeoutTreatsAsTakenOver(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix service runner is not used on windows")
	}
	runner := &unixServiceRunner{cmd: exec.Command("sleep", "30")}
	start := time.Now()
	tookOver, err := runner.restartService()
	if err != nil {
		t.Fatalf("restartService err: %v", err)
	}
	if !tookOver {
		t.Errorf("slow service command reported as not taken over")
	}
	if elapsed := time.Since(start); elapsed > serviceRestartTimeout+2*time.Second {
		t.Errorf("restartService took %s, want ~%s", elapsed, serviceRestartTimeout)
	}
}

func TestWindowsRestartScriptKeepsBareBinaryFallback(t *testing.T) {
	// Best-effort guard on the Windows path: the helper must still wait for
	// this process to exit and relaunch through the launcher, falling back to
	// the bare executable.
	script := windowsRestartScript()
	if !strings.Contains(script, "Wait-Process") {
		t.Errorf("script must wait for this process to exit: %q", script)
	}
	if !strings.Contains(script, "wscript.exe") {
		t.Errorf("script must relaunch via the startup launcher: %q", script)
	}
	if !strings.Contains(script, "} else { Start-Process") {
		t.Errorf("script must fall back to the bare executable: %q", script)
	}
}

func TestNewServiceRunnerRejectsUnsupportedOS(t *testing.T) {
	if _, err := newServiceRunner("plan9"); err == nil {
		t.Fatal("expected error for unsupported OS")
	}
}

// fakeResolver stubs the subset of updater.Checker the install path uses, so
// tests can script the GitHub Releases API without a live checker.
type fakeResolver struct {
	tag     string
	asset   string
	binURL  string
	sumsURL string // "" means the release has no sha256sums.txt asset
}

func (f *fakeResolver) LatestAsset(ctx context.Context, platform string) (tag, assetName, downloadURL string, err error) {
	if f.asset == "" {
		return "", "", "", fmt.Errorf("release has no asset for platform %q", platform)
	}
	return f.tag, f.asset, f.binURL, nil
}

func (f *fakeResolver) LatestChecksumsURL(ctx context.Context) (string, error) {
	return f.sumsURL, nil
}

// assetFixture serves the "binary" and (optionally) sha256sums.txt assets the
// release points at. The checksum matches binary when withChecksum is true.
func assetFixture(t *testing.T, binary []byte, withChecksum bool) (*httptest.Server, *fakeResolver) {
	t.Helper()
	platform := runtime.GOOS + "-" + runtime.GOARCH
	asset := "pican-" + platform
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	sum := sha256.Sum256(binary)
	sums := hex.EncodeToString(sum[:]) + "  " + asset + "\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bin":
			w.Write(binary)
		case "/sums":
			w.Write([]byte(sums))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)

	resolver := &fakeResolver{
		tag:     "v9.9.9-test",
		asset:   asset,
		binURL:  srv.URL + "/bin",
		sumsURL: srv.URL + "/sums",
	}
	if !withChecksum {
		resolver.sumsURL = ""
	}
	return srv, resolver
}

func TestInstallUpdateDownloadsAndReplaces(t *testing.T) {
	binary := []byte("#!/bin/sh\necho new-pican\n")
	_, resolver := assetFixture(t, binary, true)

	exePath := filepath.Join(t.TempDir(), "pican")
	if err := os.WriteFile(exePath, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := installUpdate(context.Background(), resolver, exePath); err != nil {
		t.Fatalf("installUpdate err: %v", err)
	}

	got, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("read replaced binary: %v", err)
	}
	if string(got) != string(binary) {
		t.Errorf("binary content = %q, want %q", got, binary)
	}
	// The replaced file must be executable.
	info, err := os.Stat(exePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o111 == 0 {
		t.Errorf("replaced binary is not executable: %v", info.Mode())
	}
	// Staging temps must be cleaned up.
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(exePath), ".pican-update-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Errorf("leftover staging files: %v", leftovers)
	}
}

func TestInstallUpdateChecksumMismatchFailsClosed(t *testing.T) {
	binary := []byte("#!/bin/sh\necho new-pican\n")
	srv, _ := assetFixture(t, binary, true)
	// Corrupt the checksum the resolver advertises.
	resolver := &fakeResolver{
		tag:    "v9.9.9-test",
		asset:  "pican-" + runtime.GOOS + "-" + runtime.GOARCH,
		binURL: srv.URL + "/bin",
		sumsURL: func() string {
			// Serve a sums file with the wrong digest for the asset.
			bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				fmt.Fprintf(w, "%064x  %s\n", 0, "pican-"+runtime.GOOS+"-"+runtime.GOARCH)
			}))
			t.Cleanup(bad.Close)
			return bad.URL + "/sums"
		}(),
	}

	exePath := filepath.Join(t.TempDir(), "pican")
	orig := []byte("old binary")
	if err := os.WriteFile(exePath, orig, 0o755); err != nil {
		t.Fatal(err)
	}

	err := installUpdate(context.Background(), resolver, exePath)
	if err == nil {
		t.Fatalf("expected checksum mismatch to fail the install")
	}
	if !strings.Contains(err.Error(), "sha256 mismatch") {
		t.Errorf("error should name the mismatch, got: %v", err)
	}
	// Fail closed: the original binary must be untouched.
	got, readErr := os.ReadFile(exePath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != string(orig) {
		t.Errorf("binary was replaced despite mismatch: %q", got)
	}
}

func TestInstallUpdateMissingChecksumProceeds(t *testing.T) {
	binary := []byte("#!/bin/sh\necho new-pican\n")
	_, resolver := assetFixture(t, binary, false) // no sha256sums.txt in release

	exePath := filepath.Join(t.TempDir(), "pican")
	if err := os.WriteFile(exePath, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Parity with install.sh (which never verifies): no checksum asset means
	// the install proceeds with a warning, not a hard failure.
	if err := installUpdate(context.Background(), resolver, exePath); err != nil {
		t.Fatalf("install without checksum asset should succeed, got: %v", err)
	}
	got, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(binary) {
		t.Errorf("binary content = %q, want %q", got, binary)
	}
}

func TestInstallUpdateSurfacesMissingAsset(t *testing.T) {
	exePath := filepath.Join(t.TempDir(), "pican")
	if err := os.WriteFile(exePath, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	resolver := &fakeResolver{} // no asset for any platform
	err := installUpdate(context.Background(), resolver, exePath)
	if err == nil {
		t.Fatalf("expected error when the release has no matching asset")
	}
	if !strings.Contains(err.Error(), "no asset") {
		t.Errorf("error should explain the missing asset, got: %v", err)
	}
	got, readErr := os.ReadFile(exePath)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != "old binary" {
		t.Errorf("binary was modified despite failure: %q", got)
	}
}

func TestVerifyChecksum(t *testing.T) {
	binary := []byte("payload")
	platform := runtime.GOOS + "-" + runtime.GOARCH
	sum := sha256.Sum256(binary)
	asset := "pican-" + platform
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}

	dir := t.TempDir()
	file := filepath.Join(dir, "downloaded")
	if err := os.WriteFile(file, binary, 0o755); err != nil {
		t.Fatal(err)
	}

	// Match.
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  %s\n", hex.EncodeToString(sum[:]), asset)
	}))
	t.Cleanup(ok.Close)
	if err := verifyChecksum(context.Background(), ok.URL, asset, file); err != nil {
		t.Errorf("matching checksum rejected: %v", err)
	}

	// Mismatch.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%064x  %s\n", 0, asset)
	}))
	t.Cleanup(bad.Close)
	if err := verifyChecksum(context.Background(), bad.URL, asset, file); err == nil {
		t.Errorf("mismatching checksum accepted")
	}

	// Missing entry for the asset fails closed.
	missing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  other-asset\n", hex.EncodeToString(sum[:]))
	}))
	t.Cleanup(missing.Close)
	if err := verifyChecksum(context.Background(), missing.URL, asset, file); err == nil {
		t.Errorf("sums file without the asset entry accepted")
	}
}

func TestChecksumForAssetParsesVariants(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	asset := "pican-darwin-arm64"
	tests := []string{
		sum + "  " + asset + "\n",
		sum + " " + asset + "\n",
		sum + " *" + asset + "\n",
		sum + "  ./" + asset + "\n",
		"# comment\n" + sum + "  " + asset + "\n",
		"garbage\n" + sum + "  " + asset + "\n",
	}
	for _, in := range tests {
		got, err := checksumForAsset(in, asset)
		if err != nil {
			t.Errorf("checksumForAsset(%q) err: %v", in, err)
			continue
		}
		if got != sum {
			t.Errorf("checksumForAsset(%q)=%q want %q", in, got, sum)
		}
	}

	// Hash on the right side also parses (lenient on column order).
	right := asset + "  " + sum + "\n"
	if got, err := checksumForAsset(right, asset); err != nil || got != sum {
		t.Errorf("right-side hash: got %q err %v", got, err)
	}
}

func TestRunInstallHookCompilesWithChecker(t *testing.T) {
	// Guard the wiring in app.go: the hook must stay func(ctx) error while
	// closing over the checker. runInstall's signature is the contract.
	checker := updater.New("dev")
	var hook func(context.Context) error = func(ctx context.Context) error {
		return runInstall(ctx, checker)
	}
	if hook == nil {
		t.Fatal("hook is nil")
	}
}
