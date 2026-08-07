import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BINARY, FIXTURES_SESSIONS, REPO_ROOT, TMP_DIR } from "./paths";

/** Directory holding the stub `pi` binary, prepended to PATH so chat works without real pi. */
const STUB_PI_DIR = join(REPO_ROOT, "e2e", "lib", "stub-pi");
const STUB_CODEX = join(REPO_ROOT, "e2e", "lib", "stub-codex", "codex");

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
  });
}

/** Build the binary only if it is missing. CI is expected to `make build` beforehand. */
export function ensureBinary(): void {
  if (existsSync(BINARY)) return;
  console.log("[e2e] pican binary missing — running `make build` (CI should prebuild)...");
  const res = spawnSync("make", ["build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error("`make build` failed; build the binary before running e2e tests");
  }
}

/** Create a fresh temp agent dir seeded with the committed sanitized fixtures. */
export function seedAgentDir(): { agentDir: string; sessionsDir: string } {
  const agentDir = join(TMP_DIR, "agent");
  const sessionsDir = join(agentDir, "sessions");
  rmSync(agentDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
  cpSync(FIXTURES_SESSIONS, sessionsDir, { recursive: true });
  return { agentDir, sessionsDir };
}

async function waitForReady(
  baseURL: string,
  path = "/",
  headers: Record<string, string> = {},
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseURL + path, { redirect: "manual", headers });
      if (res.status > 0) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become ready at ${baseURL}: ${String(lastErr)}`);
}

export interface StartedServer {
  baseURL: string;
  agentDir: string;
  sessionsDir: string;
  child: ChildProcess;
}

export interface StartedHostedServer {
  baseURL: string;
  basePath: string;
  workspaceRoot: string;
  stateRoot: string;
  proxyHeader: string;
  proxyToken: string;
  realSecretFixture: string;
  child: ChildProcess;
  logs(): string;
}

export interface StartedIsolatedServer extends StartedServer {
  /** Restart against the same port and agent directory, preserving browser URLs and server state. */
  restart(whileStopped?: () => void | Promise<void>): Promise<ChildProcess>;
  /** Stop the current process and remove this server's isolated agent directory. */
  stop(): Promise<void>;
}

function spawnTestServer(agentDir: string, port: number, logLabel = "pican"): ChildProcess {
  const child = spawn(BINARY, ["-p", String(port), "-host", "127.0.0.1", "-runtime", "pi"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      // Prepend stub `pi` so chat workers spawn the fake, never the real pi.
      PATH: `${STUB_PI_DIR}:${process.env.PATH ?? ""}`,
      // Ensure auth is off for tests regardless of the dev's shell env.
      PICAN_TOKEN: "",
      // Lower the large-session truncation thresholds so the load-earlier spec
      // can exercise pagination with a ~150-entry session instead of rendering
      // thousands of messages (which flaked under parallel CPU contention).
      // Comfortably above every other spec's session size (max ~34 entries).
      // Keep in sync with tests/load-earlier.spec.ts.
      PICAN_LARGE_SESSION_THRESHOLD:
        process.env.PICAN_LARGE_SESSION_THRESHOLD ?? "100",
      PICAN_LARGE_SESSION_TAIL_ENTRIES:
        process.env.PICAN_LARGE_SESSION_TAIL_ENTRIES ?? "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[${logLabel}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[${logLabel}] ${d}`));
  return child;
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(`server process ${child.pid ?? "unknown"} did not exit`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  try {
    await waitForExit(child);
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
    await waitForExit(child, 2_000);
  }
}

export async function startServer(): Promise<StartedServer> {
  ensureBinary();
  const { agentDir, sessionsDir } = seedAgentDir();
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const child = spawnTestServer(agentDir, port);

  await waitForReady(baseURL);
  return { baseURL, agentDir, sessionsDir, child };
}

/**
 * Start a test-owned server that can be restarted on the same port without
 * disturbing the process-wide E2E server or another worker's metrics.
 */
export async function startIsolatedServer(): Promise<StartedIsolatedServer> {
  ensureBinary();
  mkdirSync(TMP_DIR, { recursive: true });
  const agentDir = mkdtempSync(join(TMP_DIR, "agent-isolated-"));
  const sessionsDir = join(agentDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  cpSync(FIXTURES_SESSIONS, sessionsDir, { recursive: true });

  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  let child = spawnTestServer(agentDir, port, `pican:${port}`);
  let stopped = false;

  try {
    await waitForReady(baseURL);
  } catch (error) {
    await terminateServer(child);
    rmSync(agentDir, { recursive: true, force: true });
    throw error;
  }

  return {
    baseURL,
    agentDir,
    sessionsDir,
    get child() {
      return child;
    },
    async restart(whileStopped) {
      if (stopped) throw new Error("cannot restart a stopped isolated server");
      await terminateServer(child);
      await whileStopped?.();
      child = spawnTestServer(agentDir, port, `pican:${port}`);
      await waitForReady(baseURL);
      return child;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await terminateServer(child);
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

export async function startHostedCodexServer(): Promise<StartedHostedServer> {
  ensureBinary();
  mkdirSync(TMP_DIR, { recursive: true });
  const workspaceRoot = mkdtempSync(join(TMP_DIR, "hosted-workspace-"));
  const stateRoot = join(workspaceRoot, ".pican");
  mkdirSync(join(workspaceRoot, ".codex"), { recursive: true });
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const basePath = "/s/test";
  const proxyHeader = "X-Pican-Proxy-Token";
  const proxyToken = "pican-proxy-secret-e2e";
  const realSecretFixture = "scotty-real-secret-e2e";
  let output = "";

  const child = spawn(
    BINARY,
    [
      "-p",
      String(port),
      "-host",
      "127.0.0.1",
      "-runtime",
      "codex",
      "-codex-command",
      STUB_CODEX,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PICAN_MODE: "hosted",
        PICAN_BASE_PATH: basePath,
        PICAN_WORKSPACE_ROOT: workspaceRoot,
        PICAN_STATE_ROOT: stateRoot,
        PICAN_AUTH_MODE: "proxy",
        PICAN_PROXY_HEADER: proxyHeader,
        PICAN_PROXY_TOKEN: proxyToken,
        CODEX_HOME: join(workspaceRoot, ".codex"),
        CODEX_E2E_COUNTER: join(workspaceRoot, ".codex", "e2e-counter"),
        CODEX_OPAQUE_SENTINEL: "opaque-codex-e2e",
        GITHUB_TOKEN: "opaque-github-e2e",
        SCOTTY_REAL_CREDENTIAL: realSecretFixture,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (data) => {
    output += String(data);
  });
  child.stderr?.on("data", (data) => {
    output += String(data);
  });

  await waitForReady(baseURL, basePath + "/", { [proxyHeader]: proxyToken });
  return {
    baseURL,
    basePath,
    workspaceRoot,
    stateRoot,
    proxyHeader,
    proxyToken,
    realSecretFixture,
    child,
    logs: () => output,
  };
}

export function stopServer(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}
