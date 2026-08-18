import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExecOptions,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  truncateToWidth,
  visibleWidth,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { basename, delimiter, dirname, join } from "node:path";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

interface PicanState {
  pid: number;
  port: string;
  host: string;
  tailscale: boolean;
  tailscaleUrl?: string;
  startedAt: string;
}

function agentDir(): string {
  const env = process.env["PI_CODING_AGENT_DIR"];
  if (env) return env;
  return `${homedir()}/.pi/agent`;
}

async function detectHostPort(
  pi: ExtensionAPI,
): Promise<{
  host: string;
  port: string;
  tailscale: boolean;
  tailscaleUrl?: string;
} | null> {
  // 1. Try pidfile (new path first, then old for migration compat)
  const candidates = [
    `${agentDir()}/pican/pican-state.json`,
    `${agentDir()}/pican-state.json`,
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const state: PicanState = JSON.parse(raw);

      // Validate PID is still alive
      try {
        process.kill(state.pid, 0);
      } catch {
        continue;
      }

      return {
        host: state.host,
        port: state.port,
        tailscale: state.tailscale,
        tailscaleUrl: state.tailscaleUrl,
      };
    } catch {
      // try next candidate
    }
  }

  // 2. Process fallback (macOS / Linux)
  if (process.platform !== "win32") {
    try {
      const result = await pi.exec("pgrep", ["-a", "pican"]);
      const line = result.stdout.trim().split("\n")[0];
      if (line) {
        const parts = line.split(/\s+/);
        const args = parts.slice(1);
        let port = "31415";
        let host = "127.0.0.1";
        for (let i = 0; i < args.length; i++) {
          if ((args[i] === "-p" || args[i] === "--port") && args[i + 1]) {
            port = args[i + 1];
            i++;
          }
          if (args[i] === "--host" && args[i + 1]) {
            host = args[i + 1];
            i++;
          }
        }
        return { host, port, tailscale: isTailscaleHost(host) };
      }
    } catch {
      // fall through
    }
  }

  // 3. Default fallback
  return { host: "127.0.0.1", port: "31415", tailscale: false };
}

export function isTailscaleHost(host: string): boolean {
  const ip = host.split(":")[0];
  const parts = ip.split(".").map(Number);
  if (parts.length === 4) {
    return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
  }
  return ip.toLowerCase().startsWith("fd7a:115c:a1e0");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathTailscaleBin(): string | null {
  const pathEnv = process.env["PATH"] || "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "tailscale");
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function tailscaleBin(): string {
  // Prefer PATH first so user-selected CLI installs override fallback locations.
  const pathBin = pathTailscaleBin();
  if (pathBin) return pathBin;

  for (const p of [
    // DMG install paths (not in default PATH)
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/tailscale",
    // Homebrew / system paths
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/usr/bin/tailscale",
  ]) {
    if (isExecutable(p)) return p;
  }
  return "tailscale"; // final fallback to PATH lookup
}

async function detectTailscaleHttpsUrl(
  pi: ExtensionAPI,
  port: string,
): Promise<string | null> {
  try {
    const result = await pi.exec(tailscaleBin(), ["status", "--json"], {
      timeout: 10_000,
    });
    const status = JSON.parse(result.stdout);
    if (status.BackendState && status.BackendState !== "Running") return null;
    const dnsName = String(status.Self?.DNSName || "").replace(/\.$/, "");
    if (!dnsName) return null;
    return `https://${dnsName}:${port}`;
  } catch {
    return null;
  }
}

export function isSSH(): boolean {
  return !!(
    process.env["SSH_TTY"] ||
    process.env["SSH_CONNECTION"] ||
    process.env["SSH_CLIENT"]
  );
}

export function openBrowser(pi: ExtensionAPI, url: string): Promise<void> {
  let cmd: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      cmd = "cmd";
      args = ["/c", "start", url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
      break;
  }
  return pi.exec(cmd, args).then(() => {});
}

async function healthCheck(host: string, port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}`, {
      signal: AbortSignal.timeout(1000),
    });
    // 401/403 means pican is running with auth enabled.
    return res.ok || res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}

// windowsLauncher is the hidden startup launcher written by install.ps1; it
// loads ~/.config/pican/env and starts pican without a console window.
function windowsLauncher(): string {
  return join(homedir(), ".config", "pican", "pican-start.vbs");
}

async function startPican(pi: ExtensionAPI): Promise<void> {
  if (process.platform === "win32") {
    const launcher = windowsLauncher();
    if (!existsSync(launcher)) {
      throw new Error(
        "pican launcher not found; install with: curl -fsSL https://raw.githubusercontent.com/Yeshwanthyk/pican/main/install.sh | bash",
      );
    }
    await pi.exec("wscript.exe", [launcher]);
    return;
  }

  if (process.platform === "darwin") {
    await pi.exec("sh", [
      "-lc",
      `plist="$HOME/Library/LaunchAgents/com.pican.plist"; if [ ! -f "$plist" ]; then exit 127; fi; launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist" 2>/dev/null || true; launchctl kickstart -k "gui/$(id -u)/com.pican" 2>/dev/null || launchctl start com.pican`,
    ]);
    return;
  }

  if (process.platform === "linux") {
    await pi.exec("systemctl", ["--user", "start", "pican.service"]);
    return;
  }

  throw new Error(
    "auto-start is only supported on macOS launchd, Linux systemd user services, or the Windows launcher",
  );
}

async function stopPican(pi: ExtensionAPI): Promise<void> {
  if (process.platform === "win32") {
    // No service manager on Windows; the Run-key launcher only starts pican,
    // so stopping means killing the process directly (the pkill counterpart).
    await pi.exec("taskkill", ["/IM", "pican.exe", "/F"]).catch(() => {});
    return;
  }

  if (process.platform === "darwin") {
    await pi.exec("sh", [
      "-lc",
      `launchctl bootout "gui/$(id -u)/com.pican" 2>/dev/null || launchctl stop com.pican 2>/dev/null || true`,
    ]);
    return;
  }

  if (process.platform === "linux") {
    await pi.exec("systemctl", ["--user", "stop", "pican.service"]);
    return;
  }

  throw new Error(
    "stop is only supported on macOS launchd or Linux systemd user services",
  );
}

async function restartPican(pi: ExtensionAPI): Promise<void> {
  if (process.platform === "win32") {
    await stopPican(pi);
    await startPican(pi);
    return;
  }

  if (process.platform === "darwin") {
    await pi.exec("sh", [
      "-lc",
      `plist="$HOME/Library/LaunchAgents/com.pican.plist"
if [ ! -f "$plist" ]; then exit 127; fi
env_file="$HOME/.config/pican/env"
token="$(awk -F= '$1 == "PICAN_TOKEN" { sub(/^[^=]*=/, ""); print; exit }' "$env_file" 2>/dev/null || true)"
if [ -n "$token" ]; then
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:PICAN_TOKEN $token" "$plist" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PICAN_TOKEN string $token" "$plist"
  launchctl setenv PICAN_TOKEN "$token" 2>/dev/null || true
fi
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || launchctl load "$plist"
launchctl kickstart -k "gui/$(id -u)/com.pican" 2>/dev/null || launchctl start com.pican`,
    ]);
    return;
  }

  if (process.platform === "linux") {
    await pi.exec("systemctl", ["--user", "restart", "pican.service"]);
    return;
  }

  throw new Error(
    "restart is only supported on macOS launchd or Linux systemd user services",
  );
}

async function ensurePicanRunning(
  pi: ExtensionAPI,
  host: string,
  port: string,
): Promise<boolean> {
  if (await healthCheck(host, port)) return true;

  try {
    await startPican(pi);
  } catch {
    return false;
  }

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await healthCheck(host, port)) return true;
  }

  return false;
}

function picanEnvPath(): string {
  return `${homedir()}/.config/pican/env`;
}

export function readPicanToken(): string | null {
  // Check process.env first — allows PICAN_TOKEN=... pican ... usage
  const fromEnv = process.env["PICAN_TOKEN"];
  if (fromEnv) return fromEnv;

  try {
    const raw = readFileSync(picanEnvPath(), "utf-8");
    const match = raw.match(/^PICAN_TOKEN=(.*)$/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export function writePicanToken(token: string): void {
  const path = picanEnvPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);

  let content = "";
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  if (/^PICAN_TOKEN=/m.test(content)) {
    content = content.replace(/^PICAN_TOKEN=.*$/m, `PICAN_TOKEN=${token}`);
  } else {
    const trimmed = content.trimEnd();
    content = `${trimmed ? `${trimmed}\n` : ""}PICAN_TOKEN=${token}\n`;
  }

  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function withToken(url: string): string {
  const token = readPicanToken();
  if (!token) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

// ── GitHub Releases update ─────────────────────────────────────────
// `/pican update` downloads the latest release binary directly from GitHub
// Releases — the npm package no longer ships binaries. Parity with
// internal/app/update.go and install.sh: the same asset naming
// (pican-<os>-<arch>, .exe on Windows) and the same sha256sums.txt
// verification policy (verify when present, fail closed on mismatch, warn
// and proceed when the checksum asset is absent).

const PICAN_RELEASE_BASE =
  "https://github.com/Yeshwanthyk/pican/releases/latest/download";

export function picanAssetName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  let os: string;
  switch (platform) {
    case "darwin":
      os = "darwin";
      break;
    case "linux":
      os = "linux";
      break;
    case "win32":
      os = "windows";
      break;
    default:
      throw new Error(`pican update does not support platform ${platform}`);
  }
  let cpu: string;
  switch (arch) {
    case "x64":
      cpu = "amd64";
      break;
    case "arm64":
      cpu = "arm64";
      break;
    default:
      throw new Error(`pican update does not support architecture ${arch}`);
  }
  const suffix = os === "windows" ? ".exe" : "";
  return `pican-${os}-${cpu}${suffix}`;
}

export function picanReleaseDownloadUrl(assetName: string): string {
  return `${PICAN_RELEASE_BASE}/${assetName}`;
}

export function picanReleaseChecksumsUrl(): string {
  return `${PICAN_RELEASE_BASE}/sha256sums.txt`;
}

// checksumForAsset finds the expected sha256 hex digest for assetName in
// standard sha256sum output (hash + filename per line, either column order,
// optional ./ or * name prefixes). A missing entry is an error (fail closed),
// mirroring internal/app/update.go.
export function checksumForAsset(sums: string, assetName: string): string {
  for (const raw of sums.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 2) continue;
    let hash: string;
    let name: string;
    if (fields[0].length === 64) {
      hash = fields[0];
      name = fields[1];
    } else if (fields[1].length === 64) {
      hash = fields[1];
      name = fields[0];
    } else {
      continue;
    }
    name = name.replace(/^\.\//, "").replace(/^\*/, "");
    if (name === assetName) return hash.toLowerCase();
  }
  throw new Error(`sha256sums.txt has no entry for ${assetName}`);
}

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface PicanUpdateResult {
  assetName: string;
  checksumVerified: boolean;
}

export interface PicanUpdateOptions {
  platform?: string;
  arch?: string;
  assetName?: string;
  // download overrides the network step (tests inject a fake; defaults to curl).
  download?: (url: string, dest: string) => Promise<void>;
}

const RELEASE_DOWNLOAD_TIMEOUT_MS = 300_000;

// updatePicanFromRelease downloads the latest pican release for the current
// platform into a temp file next to binPath, verifies its sha256 checksum when
// the release ships sha256sums.txt (failing closed on mismatch), then
// atomically replaces binPath. Returns the installed asset name.
export async function updatePicanFromRelease(
  pi: ExtensionAPI,
  binPath: string,
  opts: PicanUpdateOptions = {},
): Promise<PicanUpdateResult> {
  const assetName =
    opts.assetName ?? picanAssetName(opts.platform, opts.arch);
  const download =
    opts.download ??
    ((url: string, dest: string) =>
      pi
        .exec("curl", ["-fsSL", "-o", dest, url], {
          timeout: RELEASE_DOWNLOAD_TIMEOUT_MS,
        })
        .then(() => {}));

  // Stage the download next to the binary so the final rename is a pure
  // rename(2) on the same filesystem (like internal/app/update.go).
  const dir = dirname(binPath);
  const tmpDir = mkdtempSync(join(dir, ".pican-update-"));
  const tmpBin = join(tmpDir, assetName);
  try {
    await download(picanReleaseDownloadUrl(assetName), tmpBin);
    chmodSync(tmpBin, 0o755);

    // Verify the checksum when the release includes sha256sums.txt; a failed
    // fetch (e.g. the asset 404s) means no checksums — proceed with a warning,
    // parity with the in-app updater.
    let sums: string | null = null;
    try {
      const res = await pi.exec("curl", ["-fsSL", picanReleaseChecksumsUrl()], {
        timeout: RELEASE_DOWNLOAD_TIMEOUT_MS,
      });
      sums = res.stdout;
    } catch {
      sums = null;
    }

    let checksumVerified = false;
    if (sums !== null) {
      const want = checksumForAsset(sums, assetName); // throws if no entry → fail closed
      const got = sha256OfFile(tmpBin);
      if (want !== got) {
        throw new Error(
          `sha256 mismatch for ${assetName}: want ${want}, got ${got}`,
        );
      }
      checksumVerified = true;
    }

    // Atomic replace: rename(2) over the running executable works on Unix.
    renameSync(tmpBin, binPath);
    return { assetName, checksumVerified };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function normalizeCommandArgs(args: unknown): string[] {
  if (Array.isArray(args)) return args.map(String);
  if (typeof args === "string")
    return args.trim() ? args.trim().split(/\s+/) : [];
  return [];
}

async function findPicanBinary(pi: ExtensionAPI): Promise<string | null> {
  // 1. Local dev build (e.g. when working inside the pican repo).
  try {
    accessSync("./pican", fsConstants.X_OK);
    return "./pican";
  } catch {
    // not in cwd
  }

  // 2. Pi-managed install (may not be in PATH).
  const piBin = `${agentDir()}/bin/pican`;
  try {
    accessSync(piBin, fsConstants.X_OK);
    return piBin;
  } catch {
    // not found
  }

  // 3. Fall back to PATH lookup.
  try {
    const result = await pi.exec("which", ["pican"]);
    const bin = result.stdout.trim();
    if (bin) return bin;
  } catch {
    // not found in PATH
  }
  return null;
}

async function getPicanVersion(pi: ExtensionAPI, bin: string): Promise<string> {
  for (const flag of ["-version", "--version"]) {
    try {
      const result = await pi.exec(bin, [flag]);
      const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
      if (output) return output;
    } catch {
      // try the next spelling
    }
  }
  return "unknown";
}

async function ensureQrCode(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  // Already available?
  try {
    await import("qrcode");
    return true;
  } catch {
    // Not available, try to install
  }

  // Find the extension directory with a package.json that depends on qrcode
  const candidates = [
    `${homedir()}/.pi/agent/extensions/pican/`,
    `${homedir()}/.pi/agent/extensions/`,
    `${ctx.sessionManager.getCwd()}/.pi/extensions/`,
  ];

  let extDir: string | null = null;
  for (const dir of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(`${dir}package.json`, "utf-8"));
      if (pkg.dependencies?.qrcode || pkg.devDependencies?.qrcode) {
        extDir = dir;
        break;
      }
    } catch {
      // continue
    }
  }

  if (!extDir) {
    return false;
  }

  ctx.ui.notify("Installing qrcode dependency...", "info");
  try {
    await pi.exec("npm", ["install"], { cwd: extDir } as ExecOptions);
    // Verify it works now
    await import("qrcode");
    return true;
  } catch {
    return false;
  }
}

class UrlOverlay extends Container implements Focusable {
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: ExtensionCommandContext["ui"]["theme"],
    private readonly keybindings: KeybindingsManager,
    private readonly title: string,
    private readonly message: string,
    private readonly url: string,
    private readonly onDismiss: () => void,
    private readonly extraLines: string[] = [],
  ) {
    super();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      data === "\u001b"
    ) {
      this.onDismiss();
    }
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg(
      "borderMuted",
      `${left}${"─".repeat(innerWidth)}${right}`,
    );
  }

  private wrapPlain(text: string, width: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word;
      } else if (visibleWidth(`${line} ${word}`) <= width) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  private wrapLong(text: string, width: number): string[] {
    const lines: string[] = [];
    for (let rest = text; rest.length > 0; ) {
      let end = Math.min(rest.length, width);
      while (end > 1 && visibleWidth(rest.slice(0, end)) > width) end--;
      lines.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    return lines.length ? lines : [""];
  }

  override render(width: number): string[] {
    const safeWidth = Math.max(40, width || 80);
    const dialogWidth = Math.max(
      64,
      Math.min(safeWidth - 4, Math.floor(safeWidth * 0.86)),
    );
    const innerWidth = Math.max(40, dialogWidth - 2);
    const urlLines = this.wrapLong(this.url, innerWidth);

    return [
      this.borderLine(innerWidth, "top"),
      this.frameLine(
        this.theme.fg("accent", this.theme.bold(` ${this.title} `)),
        innerWidth,
      ),
      this.frameLine(
        this.theme.fg("dim", "Esc closes · copy the URL below"),
        innerWidth,
      ),
      this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
      ...this.wrapPlain(this.message, innerWidth).map((line) =>
        this.frameLine(line, innerWidth),
      ),
      ...(this.extraLines.length
        ? [
            this.frameLine("", innerWidth),
            ...this.extraLines.map((line) => this.frameLine(line, innerWidth)),
          ]
        : []),
      this.frameLine("", innerWidth),
      ...urlLines.map((line) =>
        this.frameLine(this.theme.fg("success", line), innerWidth),
      ),
      this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
      this.frameLine(this.theme.fg("dim", "Press Esc to close."), innerWidth),
      this.borderLine(innerWidth, "bottom"),
    ];
  }
}

let activeUrlOverlayClose: (() => void) | null = null;

async function showUrlOverlay(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
  url: string,
  extraLines: string[] = [],
): Promise<void> {
  if (!ctx.hasUI) return;
  activeUrlOverlayClose?.();

  let closeOverlay: (() => void) | null = null;
  activeUrlOverlayClose = () => closeOverlay?.();

  void ctx.ui
    .custom<void>(
      async (tui, theme, keybindings, done) => {
        closeOverlay = () => {
          if (activeUrlOverlayClose) activeUrlOverlayClose = null;
          done();
        };
        const overlay = new UrlOverlay(
          tui,
          theme,
          keybindings,
          title,
          message,
          url,
          closeOverlay,
          extraLines,
        );
        overlay.focused = true;
        return overlay;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "94%",
          minWidth: 72,
          maxHeight: "92%",
          anchor: "top-center",
          margin: { top: 2, left: 2, right: 2 },
        },
        onHandle: (handle) => handle.focus(),
      },
    )
    .catch(() => {
      if (activeUrlOverlayClose === closeOverlay) activeUrlOverlayClose = null;
    });
}

async function showRemoteAccess(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    ctx.ui.notify("Cannot view an in-memory session.", "error");
    return;
  }

  const detected = await detectHostPort(pi);
  if (!detected) {
    ctx.ui.notify(
      "Could not detect pican server. Start it with: pican -o",
      "error",
    );
    return;
  }

  const { host, port, tailscale, tailscaleUrl } = detected;
  if (!(await ensurePicanRunning(pi, host, port))) {
    ctx.ui.notify(
      `pican not responding on ${host}:${port}. Start it with: pican -o`,
      "error",
    );
    return;
  }

  const detectedTailscaleUrl =
    tailscaleUrl || (await detectTailscaleHttpsUrl(pi, port));
  if (!tailscale && !detectedTailscaleUrl) {
    ctx.ui.notify(
      "Tailscale HTTPS is not available. Install/sign in to Tailscale and restart pican so it can run `tailscale serve`.",
      "error",
    );
    return;
  }

  const sessionId = basename(sessionFile);
  const baseUrl = detectedTailscaleUrl || `http://${host}:${port}`;
  const url = withToken(
    `${baseUrl}/session?id=${encodeURIComponent(sessionId)}`,
  );

  const hasQr = await ensureQrCode(pi, ctx);

  if (hasQr && ctx.hasUI) {
    try {
      const QRCode = await import("qrcode");
      const qrText = await QRCode.toString(url, { type: "utf8", margin: 0 });
      const qrLines = qrText.split("\n").filter((line) => line.length > 0);
      await showUrlOverlay(
        ctx,
        "Remote access via Tailscale",
        "Make sure your device is connected to Tailscale, then scan this QR code or open the URL:",
        url,
        qrLines,
      );
      ctx.ui.notify(
        "QR code shown. Make sure your device is connected to Tailscale.",
        "info",
      );
    } catch (qrErr) {
      ctx.ui.notify(
        `Failed to generate QR code: ${qrErr}. Open manually: ${url}`,
        "error",
      );
      await showUrlOverlay(
        ctx,
        "Remote access via Tailscale",
        "QR code generation failed. Make sure your device is connected to Tailscale, then open this URL:",
        url,
      );
    }
  } else {
    await showUrlOverlay(
      ctx,
      "Remote access via Tailscale",
      "QR code unavailable. Make sure your device is connected to Tailscale, then open this URL:",
      url,
    );
    ctx.ui.notify(
      `QR code unavailable. Make sure your device is connected to Tailscale, then open this URL: ${url}`,
      "warning",
    );
  }
}

export default function (pi: ExtensionAPI) {
  // Session auto-titling now lives in pican itself (see internal/server/
  // auto_title.go), gated by the /settings page, so the extension no longer
  // registers a title tool or input handler.

  // Start pican opportunistically when the extension loads so /remote works on a
  // fresh shell after installing pican via the extension or the standalone installer.
  void detectHostPort(pi)
    .then((detected) => {
      if (!detected) return;
      return ensurePicanRunning(pi, detected.host, detected.port);
    })
    .catch(() => {
      // Keep startup quiet; /remote and /refresh show actionable errors if needed.
    });

  // ── /pican ───────────────────────────────────────────────────────
  pi.registerCommand("pican", {
    description: "Manage pican: status, token, start, stop, restart, remote, update",

    handler: async (args, ctx: ExtensionCommandContext) => {
      const [subcommand = "status"] = normalizeCommandArgs(args);
      const bin = await findPicanBinary(pi);
      const detected = await detectHostPort(pi);
      const host = detected?.host || "127.0.0.1";
      const port = detected?.port || "31415";
      const running = await healthCheck(host, port);
      const tailscaleUrl =
        detected?.tailscaleUrl ||
        (running ? await detectTailscaleHttpsUrl(pi, port) : null);

      if (
        subcommand === "help" ||
        subcommand === "--help" ||
        subcommand === "-h"
      ) {
        ctx.ui.notify(
          "Usage: /pican [status|version|path|token|set-token|start|stop|restart|remote|update|help]",
          "info",
        );
        return;
      }

      if (subcommand === "path") {
        ctx.ui.notify(
          bin
            ? `pican binary: ${bin}`
            : "pican binary not found in PATH",
          bin ? "info" : "warning",
        );
        return;
      }

      if (subcommand === "version") {
        if (!bin) {
          ctx.ui.notify(
            "pican binary not found in ~/.pi/agent/bin or /usr/local/bin",
            "warning",
          );
          return;
        }
        ctx.ui.notify(
          `pican version: ${await getPicanVersion(pi, bin)}`,
          "info",
        );
        return;
      }

      if (subcommand === "start") {
        if (running) {
          const lines = [`pican already running at ${withToken(`http://${host}:${port}`)}`];
          if (tailscaleUrl) lines.push(`remote: ${withToken(tailscaleUrl)}`);
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        try {
          await startPican(pi);
          let started = false;
          for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (await healthCheck(host, port)) {
              started = true;
              break;
            }
          }
          const remoteURL = await detectTailscaleHttpsUrl(pi, port);
          const lines = [
            started
              ? `Started pican at ${withToken(`http://${host}:${port}`)}`
              : "Started pican; still waiting for health check.",
          ];
          if (remoteURL) lines.push(`remote: ${withToken(remoteURL)}`);
          ctx.ui.notify(lines.join("\n"), started ? "success" : "warning");
        } catch (err) {
          ctx.ui.notify(`Failed to start pican: ${err}`, "error");
        }
        return;
      }

      if (subcommand === "stop") {
        try {
          await stopPican(pi);
          ctx.ui.notify("Stopped pican.", "success");
        } catch (err) {
          ctx.ui.notify(`Failed to stop pican: ${err}`, "error");
        }
        return;
      }

      if (subcommand === "restart") {
        try {
          await restartPican(pi);
          let restarted = false;
          for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (await healthCheck(host, port)) {
              restarted = true;
              break;
            }
          }
          const remoteURL = await detectTailscaleHttpsUrl(pi, port);
          const lines = [
            restarted
              ? `Restarted pican at ${withToken(`http://${host}:${port}`)}`
              : "Restarted pican; still waiting for health check.",
          ];
          if (remoteURL) lines.push(`remote: ${withToken(remoteURL)}`);
          ctx.ui.notify(lines.join("\n"), restarted ? "success" : "warning");
        } catch (err) {
          ctx.ui.notify(`Failed to restart pican: ${err}`, "error");
        }
        return;
      }

      if (subcommand === "token") {
        const token = readPicanToken();
        if (token) {
          ctx.ui.notify(`Current token: ${token}`, "info");
        } else {
          ctx.ui.notify(
            "No token set. Use /pican set-token <token> to create one.",
            "warning",
          );
        }
        return;
      }

      if (subcommand === "set-token") {
        const [, newToken] = normalizeCommandArgs(args);
        if (!newToken) {
          ctx.ui.notify(
            "Usage: /pican set-token <token>",
            "warning",
          );
          return;
        }
        writePicanToken(newToken);
        ctx.ui.notify(
          `Token updated. Restart pican for the change to take effect: /pican restart`,
          "success",
        );
        return;
      }

      if (subcommand === "remote") {
        await showRemoteAccess(pi, ctx);
        return;
      }

      if (subcommand === "update") {
        if (!bin) {
          ctx.ui.notify(
            "pican binary not found. Install it with:\ncurl -fsSL https://raw.githubusercontent.com/Yeshwanthyk/pican/main/install.sh | bash",
            "error",
          );
          return;
        }
        try {
          ctx.ui.notify("Downloading latest pican release...", "info");
          const { assetName, checksumVerified } =
            await updatePicanFromRelease(pi, bin);
          try {
            await restartPican(pi);
          } catch {
            // Binary update may still have succeeded even if the service is not installed/running.
          }
          const note = checksumVerified
            ? "checksum verified"
            : "WARNING: sha256sums.txt not found, checksum skipped";
          ctx.ui.notify(
            `pican updated to latest release (${assetName}, ${note}). Reloading pi extensions...`,
            checksumVerified ? "success" : "warning",
          );
          await ctx.reload();
          return;
        } catch (err) {
          ctx.ui.notify(
            `Failed to update pican: ${err}\nInstall with: curl -fsSL https://raw.githubusercontent.com/Yeshwanthyk/pican/main/install.sh | bash`,
            "error",
          );
        }
        return;
      }

      if (subcommand !== "status") {
        ctx.ui.notify(
          `Unknown /pican command: ${subcommand}. Usage: /pican [status|version|path|token|set-token|start|stop|restart|remote|update|help]`,
          "warning",
        );
        return;
      }

      const lines = [
        `binary: ${bin || "not found (~/.pi/agent/bin/pican, /usr/local/bin/pican)"}`,
        `status: ${running ? "running" : "not responding"}`,
        `local: ${withToken(`http://${host}:${port}`)}`,
      ];
      if (tailscaleUrl) lines.push(`remote: ${withToken(tailscaleUrl)}`);
      if (detected?.tailscaleUrl && detected.tailscaleUrl !== tailscaleUrl)
        lines.push(`state remote: ${withToken(detected.tailscaleUrl)}`);
      ctx.ui.notify(lines.join("\n"), running ? "info" : "warning");
    },
  });

  // ── /web ─────────────────────────────────────────────────────────
  pi.registerCommand("web", {
    description: "Open current session in browser",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Cannot view an in-memory session.", "error");
        return;
      }

      const detected = await detectHostPort(pi);
      if (!detected) {
        ctx.ui.notify(
          "Could not detect pican server. Start it with: pican -o",
          "error",
        );
        return;
      }

      let { host, port, tailscaleUrl } = detected;
      if (!(await ensurePicanRunning(pi, host, port))) {
        ctx.ui.notify(
          `pican not responding on ${host}:${port}. Start it with: pican -o`,
          "error",
        );
        return;
      }

      // Re-read state after startup — auto-start may have changed host/port
      // or tailscale serve may now be available.
      const refreshed = await detectHostPort(pi);
      if (refreshed) {
        host = refreshed.host;
        port = refreshed.port;
        tailscaleUrl = refreshed.tailscaleUrl || tailscaleUrl;
      }
      if (!tailscaleUrl) {
        tailscaleUrl = await detectTailscaleHttpsUrl(pi, port) || undefined;
      }

      const sessionId = basename(sessionFile);
      const baseUrl = tailscaleUrl || `http://${host}:${port}`;
      const url = withToken(
        `${baseUrl}/session?id=${encodeURIComponent(sessionId)}`,
      );

      const inSSH = isSSH();
      ctx.ui.notify(
        `Session URL: ${url}`,
        "info",
      );

      if (inSSH) {
        ctx.ui.notify(
          "Running over SSH — skipping browser open. Use the URL above.",
          "info",
        );
        return;
      }

      try {
        await openBrowser(pi, url);
      } catch {
        ctx.ui.notify(
          `Failed to open browser. Open manually: ${url}`,
          "warning",
        );
      }
    },
  });

  // ── /remote ───────────────────────────────────────────────────────
  pi.registerCommand("remote", {
    description: "Show QR code for remote Tailscale access",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await showRemoteAccess(pi, ctx);
    },
  });

  // ── /refresh ──────────────────────────────────────────────────────
  pi.registerCommand("refresh", {
    description: "Sync pican-written messages back into this session",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Cannot refresh an in-memory session.", "error");
        return;
      }

      let fileEntries: unknown[] = [];
      try {
        const raw = readFileSync(sessionFile, "utf-8");
        fileEntries = raw
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line));
      } catch (err) {
        ctx.ui.notify(`Failed to read session file: ${err}`, "error");
        return;
      }

      const currentCount = ctx.sessionManager.getEntries().length;
      // fileEntries includes header, so subtract 1 for message entries
      const fileCount = Math.max(0, fileEntries.length - 1);

      if (fileCount > currentCount) {
        const delta = fileCount - currentCount;
        ctx.ui.notify(
          `Mobile added ${delta} new message(s). Reloading session...`,
          "info",
        );
        await ctx.switchSession(sessionFile);
      } else {
        ctx.ui.notify("Session is up to date.", "info");
      }
    },
  });
}
