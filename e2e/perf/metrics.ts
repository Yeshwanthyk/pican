import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import type { CDPSession, Page, TestInfo } from "@playwright/test";
import {
  PERF_PROFILE_VERSION,
  PERF_RESULT_KIND,
  PERF_RESULT_SCHEMA_VERSION,
  parsePerfResult,
  type Capability,
  type JsonValue,
  type PerfEnvironment,
  type PerfProfile,
  type PerfResult,
} from "./result-schema.ts";

export interface ResourceAttribution {
  /** URL pathname plus query string; origins and fragments are intentionally omitted. */
  readonly pathnameAndQuery: string;
  readonly initiatorType: string;
  readonly transferBytes: number;
  readonly decodedBytes: number;
  readonly startTime: number;
  readonly duration: number;
}

export interface PerfSnapshot {
  readonly nowMs: number;
  readonly navigation: Record<string, number> | null;
  readonly paints: readonly { name: string; startTime: number }[];
  readonly largestContentfulPaintMs: number | null;
  readonly cumulativeLayoutShift: number;
  readonly longTasks: readonly { startTime: number; duration: number }[];
  readonly observerCapabilities: {
    readonly longTasks: boolean;
    readonly layoutShift: boolean;
    readonly largestContentfulPaint: boolean;
  };
  readonly resources: {
    readonly count: number;
    readonly transferBytes: number;
    readonly decodedBytes: number;
    readonly entries: readonly ResourceAttribution[];
    readonly byKind: Record<
      string,
      { count: number; transferBytes: number; decodedBytes: number }
    >;
  };
  readonly domElements: number;
  readonly visibleTranscriptEntries: number;
  readonly jsHeapUsedBytes: number | null;
}

export interface PerfSnapshotDelta {
  readonly boundary: {
    readonly startMs: number;
    readonly endMs: number;
    readonly durationMs: number;
  };
  readonly longTasks: {
    readonly count: number;
    readonly totalDurationMs: number;
    readonly maxDurationMs: number;
    readonly entries: readonly { startTime: number; duration: number }[];
  };
  readonly resources: {
    readonly count: number;
    readonly transferBytes: number;
    readonly decodedBytes: number;
    readonly entries: readonly ResourceAttribution[];
  };
  readonly domElementsDelta: number;
  readonly visibleTranscriptEntriesDelta: number;
  readonly jsHeapUsedBytesDelta: number | null;
}

export interface PerfProfileApplication {
  readonly profile: PerfProfile;
  readonly cdpSession: CDPSession | null;
  readonly capabilities: {
    readonly cdp: Capability;
    readonly networkThrottling: Capability;
    readonly cpuThrottling: Capability;
  };
}

export interface PerfArtifactOptions {
  readonly browserVersion?: string | null;
  readonly playwrightVersion?: string | null;
}

const require = createRequire(import.meta.url);
const PROCESS_RUN_ID =
  process.env.PICAN_PERF_RUN_ID ??
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;

const SUPPORTED: Capability = { status: "supported", reason: null };
const NOT_REQUESTED: Capability = {
  status: "not-requested",
  reason: null,
};

function unsupported(reason: string): Capability {
  return { status: "unsupported", reason };
}

function unavailable(reason: string): Capability {
  return { status: "unavailable", reason };
}

export function selectedPerfProfile(): PerfProfile {
  const id = process.env.PICAN_PERF_PROFILE ?? "unthrottled-local";
  if (id === "unthrottled-local") {
    return {
      id,
      version: PERF_PROFILE_VERSION,
      parameters: {
        latencyMs: null,
        downloadBytesPerSecond: null,
        uploadBytesPerSecond: null,
        cpuSlowdownFactor: null,
      },
    };
  }
  if (id === "mobile4g") {
    return {
      id,
      version: PERF_PROFILE_VERSION,
      parameters: {
        latencyMs: 150,
        downloadBytesPerSecond: 500_000,
        uploadBytesPerSecond: 250_000,
        cpuSlowdownFactor: 4,
      },
    };
  }
  throw new Error(
    `unsupported PICAN_PERF_PROFILE ${JSON.stringify(id)}; expected unthrottled-local or mobile4g`,
  );
}

export async function installPerformanceObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const supported = new Set(PerformanceObserver.supportedEntryTypes ?? []);
    const state = {
      longTasks: [] as { startTime: number; duration: number }[],
      layoutShift: 0,
      largestContentfulPaint: null as number | null,
      observerCapabilities: {
        longTasks: supported.has("longtask"),
        layoutShift: supported.has("layout-shift"),
        largestContentfulPaint: supported.has("largest-contentful-paint"),
      },
    };
    Object.defineProperty(window, "__picanPerf", {
      value: state,
      configurable: true,
    });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {
      state.observerCapabilities.longTasks = false;
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            value?: number;
            hadRecentInput?: boolean;
          };
          if (!shift.hadRecentInput) state.layoutShift += shift.value ?? 0;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      state.observerCapabilities.layoutShift = false;
    }
    try {
      new PerformanceObserver((list) => {
        const latest = list.getEntries().at(-1);
        if (latest) state.largestContentfulPaint = latest.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      state.observerCapabilities.largestContentfulPaint = false;
    }
  });
}

export async function applyOptionalThrottle(
  page: Page,
): Promise<PerfProfileApplication> {
  const profile = selectedPerfProfile();
  const browserName =
    page.context().browser()?.browserType().name() ?? "unavailable";
  if (profile.id === "unthrottled-local") {
    return {
      profile,
      cdpSession: null,
      capabilities: {
        cdp:
          browserName === "chromium"
            ? SUPPORTED
            : unsupported("CDP sessions are Chromium-only in Playwright"),
        networkThrottling: NOT_REQUESTED,
        cpuThrottling: NOT_REQUESTED,
      },
    };
  }
  if (browserName !== "chromium") {
    const reason = `profile ${profile.id}@${profile.version} requires Chromium CDP; ${browserName} is explicitly unsupported`;
    return {
      profile,
      cdpSession: null,
      capabilities: {
        cdp: unsupported("CDP sessions are Chromium-only in Playwright"),
        networkThrottling: unsupported(reason),
        cpuThrottling: unsupported(reason),
      },
    };
  }

  const cdpSession = await page.context().newCDPSession(page);
  await cdpSession.send("Network.enable");
  await cdpSession.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: profile.parameters.latencyMs!,
    downloadThroughput: profile.parameters.downloadBytesPerSecond!,
    uploadThroughput: profile.parameters.uploadBytesPerSecond!,
    connectionType: "cellular4g",
  });
  await cdpSession.send("Emulation.setCPUThrottlingRate", {
    rate: profile.parameters.cpuSlowdownFactor!,
  });
  return {
    profile,
    cdpSession,
    capabilities: {
      cdp: SUPPORTED,
      networkThrottling: SUPPORTED,
      cpuThrottling: SUPPORTED,
    },
  };
}

export async function collectSnapshot(page: Page): Promise<PerfSnapshot> {
  return page.evaluate(() => {
    type PerfState = {
      longTasks: { startTime: number; duration: number }[];
      layoutShift: number;
      largestContentfulPaint: number | null;
      observerCapabilities: {
        longTasks: boolean;
        layoutShift: boolean;
        largestContentfulPaint: boolean;
      };
    };
    const state = (window as unknown as { __picanPerf?: PerfState })
      .__picanPerf;
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const resources = performance.getEntriesByType(
      "resource",
    ) as PerformanceResourceTiming[];
    const entries = resources.map((resource) => {
      let pathnameAndQuery = resource.name;
      try {
        const url = new URL(resource.name, window.location.href);
        pathnameAndQuery = `${url.pathname}${url.search}`;
      } catch {
        // Keep the raw performance entry name when URL parsing is impossible.
      }
      return {
        pathnameAndQuery,
        initiatorType: resource.initiatorType || "unknown",
        transferBytes: resource.transferSize,
        decodedBytes: resource.decodedBodySize,
        startTime: resource.startTime,
        duration: resource.duration,
      };
    });
    const byKind: Record<
      string,
      { count: number; transferBytes: number; decodedBytes: number }
    > = {};
    for (const resource of entries) {
      const path = resource.pathnameAndQuery;
      const pathWithoutQuery = path.split("?", 1)[0];
      const kind = pathWithoutQuery.startsWith("/api/")
        ? path
        : pathWithoutQuery.endsWith(".js")
          ? "script"
          : pathWithoutQuery.endsWith(".css")
            ? "style"
            : path;
      const bucket = (byKind[kind] ??= {
        count: 0,
        transferBytes: 0,
        decodedBytes: 0,
      });
      bucket.count += 1;
      bucket.transferBytes += resource.transferBytes;
      bucket.decodedBytes += resource.decodedBytes;
    }
    const memory = performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    };
    return {
      nowMs: performance.now(),
      navigation: navigation
        ? {
            responseStart: navigation.responseStart,
            domContentLoaded: navigation.domContentLoadedEventEnd,
            loadEnd: navigation.loadEventEnd,
          }
        : null,
      paints: performance.getEntriesByType("paint").map((entry) => ({
        name: entry.name,
        startTime: entry.startTime,
      })),
      largestContentfulPaintMs: state?.largestContentfulPaint ?? null,
      cumulativeLayoutShift: state?.layoutShift ?? 0,
      longTasks: state?.longTasks ?? [],
      observerCapabilities: state?.observerCapabilities ?? {
        longTasks: false,
        layoutShift: false,
        largestContentfulPaint: false,
      },
      resources: {
        count: entries.length,
        transferBytes: entries.reduce(
          (sum, resource) => sum + resource.transferBytes,
          0,
        ),
        decodedBytes: entries.reduce(
          (sum, resource) => sum + resource.decodedBytes,
          0,
        ),
        entries,
        byKind,
      },
      domElements: document.getElementsByTagName("*").length,
      visibleTranscriptEntries: document.querySelectorAll(
        '#messages [id^="entry-"]',
      ).length,
      jsHeapUsedBytes: memory.memory?.usedJSHeapSize ?? null,
    };
  });
}

function resourceIdentity(resource: ResourceAttribution): string {
  return [
    resource.pathnameAndQuery,
    resource.initiatorType,
    resource.startTime,
    resource.duration,
  ].join("\u0000");
}

export function snapshotDelta(
  before: PerfSnapshot,
  after: PerfSnapshot,
): PerfSnapshotDelta {
  if (after.nowMs < before.nowMs) {
    throw new Error("snapshot boundary end precedes its start");
  }
  const previousResources = new Set(
    before.resources.entries.map(resourceIdentity),
  );
  const resources = after.resources.entries.filter(
    (resource) => !previousResources.has(resourceIdentity(resource)),
  );
  const longTasks = after.longTasks.filter(
    (task) => task.startTime >= before.nowMs && task.startTime < after.nowMs,
  );
  return {
    boundary: {
      startMs: before.nowMs,
      endMs: after.nowMs,
      durationMs: after.nowMs - before.nowMs,
    },
    longTasks: {
      count: longTasks.length,
      totalDurationMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
      maxDurationMs: longTasks.reduce(
        (maximum, task) => Math.max(maximum, task.duration),
        0,
      ),
      entries: longTasks,
    },
    resources: {
      count: resources.length,
      transferBytes: resources.reduce(
        (sum, resource) => sum + resource.transferBytes,
        0,
      ),
      decodedBytes: resources.reduce(
        (sum, resource) => sum + resource.decodedBytes,
        0,
      ),
      entries: resources,
    },
    domElementsDelta: after.domElements - before.domElements,
    visibleTranscriptEntriesDelta:
      after.visibleTranscriptEntries - before.visibleTranscriptEntries,
    jsHeapUsedBytesDelta:
      before.jsHeapUsedBytes === null || after.jsHeapUsedBytes === null
        ? null
        : after.jsHeapUsedBytes - before.jsHeapUsedBytes,
  };
}

export async function collectChromiumMemory(
  page: Page,
): Promise<Record<string, number> | null> {
  if (page.context().browser()?.browserType().name() !== "chromium")
    return null;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const counters = await cdp.send("Memory.getDOMCounters");
    const performanceMetrics = await cdp.send("Performance.getMetrics");
    const selected = Object.fromEntries(
      performanceMetrics.metrics
        .filter((metric) =>
          ["JSHeapUsedSize", "Nodes", "Documents", "LayoutCount"].includes(
            metric.name,
          ),
        )
        .map((metric) => [metric.name, metric.value]),
    );
    return {
      ...selected,
      documents: counters.documents,
      nodes: counters.nodes,
      jsEventListeners: counters.jsEventListeners,
    };
  } catch {
    return null;
  }
}

function playwrightVersion(): string | null {
  try {
    return (
      (require("playwright/package.json") as { version?: string }).version ??
      null
    );
  } catch {
    return null;
  }
}

function browserName(testInfo: TestInfo): string {
  const configured = testInfo.project.use.browserName;
  if (typeof configured === "string") return configured;
  const name = testInfo.project.name.toLowerCase();
  if (name.includes("webkit") || name.includes("safari")) return "webkit";
  if (name.includes("firefox")) return "firefox";
  if (name.includes("chrom")) return "chromium";
  return "unknown";
}

function profileCapabilities(
  name: string,
  profile: PerfProfile,
): Pick<
  PerfEnvironment["capabilities"],
  "cdp" | "networkThrottling" | "cpuThrottling"
> {
  if (name !== "chromium") {
    const reason = `Playwright ${name} does not expose CDP`;
    return {
      cdp: unsupported(reason),
      networkThrottling:
        profile.id === "mobile4g" ? unsupported(reason) : NOT_REQUESTED,
      cpuThrottling:
        profile.id === "mobile4g" ? unsupported(reason) : NOT_REQUESTED,
    };
  }
  return {
    cdp: SUPPORTED,
    networkThrottling: profile.id === "mobile4g" ? SUPPORTED : NOT_REQUESTED,
    cpuThrottling: profile.id === "mobile4g" ? SUPPORTED : NOT_REQUESTED,
  };
}

function findSnapshot(value: unknown): PerfSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.nowMs === "number" &&
    typeof object.observerCapabilities === "object" &&
    object.observerCapabilities !== null &&
    typeof object.resources === "object" &&
    object.resources !== null
  ) {
    return value as PerfSnapshot;
  }
  for (const child of Object.values(object)) {
    const snapshot = findSnapshot(child);
    if (snapshot) return snapshot;
  }
  return null;
}

function environmentFor(
  testInfo: TestInfo,
  payload: Record<string, unknown>,
  options: PerfArtifactOptions,
): PerfEnvironment {
  const name = browserName(testInfo);
  const profile = selectedPerfProfile();
  const viewport = testInfo.project.use.viewport;
  if (
    !viewport ||
    typeof viewport.width !== "number" ||
    typeof viewport.height !== "number"
  ) {
    throw new Error(
      "performance results require an explicit Playwright viewport",
    );
  }
  const deviceScaleFactor = testInfo.project.use.deviceScaleFactor ?? 1;
  const snapshot = findSnapshot(payload);
  const observer = snapshot?.observerCapabilities;
  const headlessSetting = testInfo.project.use.headless;
  const headless =
    typeof headlessSetting === "boolean"
      ? headlessSetting
      : !process.argv.includes("--headed") && process.env.PWDEBUG !== "1";
  return {
    os: { platform: platform(), release: release(), arch: arch() },
    nodeVersion: process.version,
    playwrightVersion: options.playwrightVersion ?? playwrightVersion(),
    browser: {
      name,
      version:
        options.browserVersion ??
        process.env.PICAN_PERF_BROWSER_VERSION ??
        null,
    },
    viewport: {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor,
    },
    headless,
    profile,
    capabilities: {
      ...profileCapabilities(name, profile),
      resourceTiming: snapshot
        ? SUPPORTED
        : unavailable("no browser performance snapshot was recorded"),
      longTasks: observer?.longTasks
        ? SUPPORTED
        : unsupported("PerformanceObserver longtask entries were unavailable"),
      layoutShift: observer?.layoutShift
        ? SUPPORTED
        : unsupported(
            "PerformanceObserver layout-shift entries were unavailable",
          ),
      largestContentfulPaint: observer?.largestContentfulPaint
        ? SUPPORTED
        : unsupported(
            "PerformanceObserver largest-contentful-paint entries were unavailable",
          ),
      performanceMemory:
        name === "chromium"
          ? SUPPORTED
          : snapshot?.jsHeapUsedBytes !== null &&
              snapshot?.jsHeapUsedBytes !== undefined
            ? SUPPORTED
            : unsupported("performance.memory was unavailable"),
      chromiumMemory:
        name !== "chromium"
          ? unsupported("Chromium CDP memory metrics are engine-specific")
          : SUPPORTED,
    },
  };
}

function positiveIntegerEnvironment(name: string): number | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function temperature(): "cold" | "warm" {
  const value = process.env.PICAN_PERF_TEMPERATURE ?? "cold";
  if (value !== "cold" && value !== "warm") {
    throw new Error("PICAN_PERF_TEMPERATURE must be cold or warm");
  }
  return value;
}

function commandOutput(
  command: string,
  args: readonly string[],
): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 80) || "unnamed"
  );
}

function jsonMeasurements(
  payload: Record<string, unknown>,
): Record<string, JsonValue> {
  const checked = parsePerfResult({
    kind: PERF_RESULT_KIND,
    schemaVersion: PERF_RESULT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    git: { sha: "validation", dirty: false },
    run: {
      runId: "validation",
      sampleId: "validation",
      repetition: 1,
      temperature: "cold",
    },
    project: "validation",
    scenario: "validation",
    environment: {
      os: { platform: "validation", release: "validation", arch: "validation" },
      nodeVersion: "validation",
      playwrightVersion: null,
      browser: { name: "validation", version: null },
      viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
      headless: true,
      profile: selectedPerfProfile(),
      capabilities: {
        cdp: NOT_REQUESTED,
        networkThrottling: NOT_REQUESTED,
        cpuThrottling: NOT_REQUESTED,
        resourceTiming: NOT_REQUESTED,
        longTasks: NOT_REQUESTED,
        layoutShift: NOT_REQUESTED,
        largestContentfulPaint: NOT_REQUESTED,
        performanceMemory: NOT_REQUESTED,
        chromiumMemory: NOT_REQUESTED,
      },
    },
    measurements: payload,
  });
  return { ...checked.measurements };
}

export async function writePerfArtifact(
  testInfo: TestInfo,
  payload: Record<string, unknown>,
  options: PerfArtifactOptions = {},
): Promise<string> {
  if (typeof payload.scenario !== "string" || payload.scenario.length === 0) {
    throw new Error("performance payload requires a non-empty scenario");
  }
  const { scenario, ...rawMeasurements } = payload;
  const sha =
    commandOutput("git", ["rev-parse", "--short=12", "HEAD"]) ?? "unknown";
  const dirty = (commandOutput("git", ["status", "--porcelain"]) ?? "") !== "";
  const repetition =
    positiveIntegerEnvironment("PICAN_PERF_REPETITION") ??
    (testInfo.repeatEachIndex ?? 0) + 1;
  const samplePrefix =
    process.env.PICAN_PERF_SAMPLE_ID ?? testInfo.testId ?? testInfo.title;
  const sampleId = `${randomUUID()}-${slug(samplePrefix)}-r${repetition}`;
  const result: PerfResult = parsePerfResult({
    kind: PERF_RESULT_KIND,
    schemaVersion: PERF_RESULT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    git: { sha, dirty },
    run: {
      runId: PROCESS_RUN_ID,
      sampleId,
      repetition,
      temperature: temperature(),
    },
    project: testInfo.project.name,
    scenario,
    environment: environmentFor(testInfo, payload, options),
    measurements: jsonMeasurements(rawMeasurements),
  });
  const json = JSON.stringify(result, null, 2) + "\n";

  const attachmentPath = testInfo.outputPath(`metrics-${slug(sampleId)}.json`);
  mkdirSync(dirname(attachmentPath), { recursive: true });
  writeFileSync(attachmentPath, json, { flag: "wx" });
  await testInfo.attach("performance-metrics", {
    path: attachmentPath,
    contentType: "application/json",
  });

  const outputDir = resolve(
    process.cwd(),
    process.env.PICAN_PERF_OUTPUT_DIR ?? "perf-results",
  );
  mkdirSync(outputDir, { recursive: true });
  const resultPath = resolve(
    outputDir,
    [
      slug(sha),
      slug(result.environment.profile.id),
      slug(result.scenario),
      slug(result.run.runId),
      slug(result.run.sampleId),
    ].join("--") + ".json",
  );
  writeFileSync(resultPath, json, { flag: "wx" });
  return resultPath;
}
