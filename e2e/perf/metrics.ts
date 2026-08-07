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
  type PerfTemperatureSetup,
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
  readonly timeOriginUnixMs: number;
  readonly nowMs: number;
  readonly navigation: Record<string, number> | null;
  readonly paints: readonly { name: string; startTime: number }[];
  readonly largestContentfulPaintMs: number | null;
  readonly cumulativeLayoutShift: number;
  readonly longTasks: readonly { startTime: number; duration: number }[];
  readonly longTasksTruncated: boolean;
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
    readonly entriesTruncated: boolean;
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

export interface ChromiumPerformanceMetrics {
  readonly timestampSeconds: number;
  readonly taskDurationSeconds: number;
  readonly scriptDurationSeconds: number;
  readonly layoutDurationSeconds: number;
  readonly recalcStyleDurationSeconds: number;
  readonly layoutCount: number;
  readonly recalcStyleCount: number;
  readonly nodes: number;
  readonly documents: number;
  readonly frames: number;
  readonly jsEventListeners: number;
  readonly jsHeapUsedBytes: number;
  readonly jsHeapTotalBytes: number;
}

export interface ChromiumPerformanceCapture {
  readonly capability: Capability;
  readonly metrics: ChromiumPerformanceMetrics | null;
}

export interface ServerMetricsSnapshot {
  readonly capturedAtUnixMs: number;
  readonly process: {
    readonly pid: number;
    readonly uptimeSeconds: number;
    readonly goroutines: number;
    readonly heapAllocBytes: number;
    readonly sseClients: number;
    readonly sseGlobalStreams: number;
    readonly sseSessionStreams: number;
    readonly sseHeartbeats: number;
    readonly sseWriteErrors: number;
    readonly sseFlushErrors: number;
    readonly watchedFiles: number;
  };
  readonly sessionCache: {
    readonly summaryParses: number;
    readonly summaryHits: number;
    readonly sessionParses: number;
    readonly sessionHits: number;
    readonly sessionEntries: number;
    readonly sessionBytes: number;
    readonly sessionEvictions: number;
  };
  /** Bounded aggregates; worker/session identifiers are intentionally omitted. */
  readonly workers: {
    readonly count: number;
    readonly sampledCount: number;
    readonly zombieCount: number;
    readonly rssBytes: number;
    readonly cpuTimeSeconds: number;
  };
}

export interface ServerMetricsCapture {
  readonly capability: Capability;
  readonly snapshot: ServerMetricsSnapshot | null;
}

export interface TaskBoundaryMetrics {
  readonly name: string;
  readonly browser: {
    readonly before: PerfSnapshot;
    readonly after: PerfSnapshot;
    readonly delta: PerfSnapshotDelta;
  };
  readonly chromium: {
    readonly before: ChromiumPerformanceCapture;
    readonly after: ChromiumPerformanceCapture;
    readonly delta: ChromiumPerformanceMetrics | null;
  };
  readonly server: {
    readonly before: ServerMetricsCapture;
    readonly after: ServerMetricsCapture;
    readonly delta: Record<string, JsonValue> | null;
  };
}

export interface RetainedStateSnapshot {
  readonly forcedGarbageCollection: Capability;
  readonly browserDom: {
    readonly domElements: number;
    readonly visibleTranscriptEntries: number;
  };
  readonly chromium: ChromiumPerformanceCapture;
}

export interface RetainedStateDelta {
  readonly domElements: number;
  readonly domElementsChangeRatio: number | null;
  readonly visibleTranscriptEntries: number;
  readonly chromium: ChromiumPerformanceMetrics | null;
  readonly chromiumNodesChangeRatio: number | null;
  readonly jsHeapUsedBytesChangeRatio: number | null;
}

interface TemperaturePreparation {
  readonly temperature: "cold" | "warm";
  readonly initialPageUrl: "about:blank";
  readonly targetPathnameAndQuery: string;
  readonly prime: PerfTemperatureSetup["prime"];
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
const CDP_METRIC_NAMES = {
  Timestamp: "timestampSeconds",
  TaskDuration: "taskDurationSeconds",
  ScriptDuration: "scriptDurationSeconds",
  LayoutDuration: "layoutDurationSeconds",
  RecalcStyleDuration: "recalcStyleDurationSeconds",
  LayoutCount: "layoutCount",
  RecalcStyleCount: "recalcStyleCount",
  Nodes: "nodes",
  Documents: "documents",
  Frames: "frames",
  JSEventListeners: "jsEventListeners",
  JSHeapUsedSize: "jsHeapUsedBytes",
  JSHeapTotalSize: "jsHeapTotalBytes",
} as const;

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
      longTasksTruncated: false,
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
          if (state.longTasks.length > 200) {
            state.longTasks.splice(0, state.longTasks.length - 200);
            state.longTasksTruncated = true;
          }
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
      longTasksTruncated: boolean;
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
    const boundedByKind = Object.fromEntries(
      Object.entries(byKind)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 100),
    );
    if (Object.keys(byKind).length > 100) {
      const retainedKinds = new Set(Object.keys(boundedByKind));
      boundedByKind.other = Object.entries(byKind)
        .filter(([kind]) => !retainedKinds.has(kind))
        .reduce(
          (total, [, item]) => ({
            count: total.count + item.count,
            transferBytes: total.transferBytes + item.transferBytes,
            decodedBytes: total.decodedBytes + item.decodedBytes,
          }),
          { count: 0, transferBytes: 0, decodedBytes: 0 },
        );
    }
    const memory = performance as Performance & {
      memory?: { usedJSHeapSize?: number };
    };
    return {
      timeOriginUnixMs: performance.timeOrigin,
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
      longTasksTruncated: state?.longTasksTruncated ?? false,
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
        entries: entries.slice(-200),
        entriesTruncated: entries.length > 200,
        byKind: boundedByKind,
      },
      domElements: document.getElementsByTagName("*").length,
      visibleTranscriptEntries: document.querySelectorAll(
        '#messages [id^="entry-"]',
      ).length,
      jsHeapUsedBytes: memory.memory?.usedJSHeapSize ?? null,
    };
  });
}

export function snapshotDelta(
  before: PerfSnapshot,
  after: PerfSnapshot,
): PerfSnapshotDelta {
  const startMs = before.timeOriginUnixMs + before.nowMs;
  const endMs = after.timeOriginUnixMs + after.nowMs;
  if (endMs < startMs) {
    throw new Error("snapshot boundary end precedes its start");
  }
  const resources = after.resources.entries.filter((resource) => {
    const startedAt = after.timeOriginUnixMs + resource.startTime;
    return startedAt >= startMs && startedAt < endMs;
  });
  const longTasks = after.longTasks.filter((task) => {
    const startedAt = after.timeOriginUnixMs + task.startTime;
    return startedAt >= startMs && startedAt < endMs;
  });
  return {
    boundary: {
      startMs,
      endMs,
      durationMs: endMs - startMs,
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

function pageBrowserName(page: Page): string {
  return page.context().browser()?.browserType().name() ?? "unavailable";
}

function selectedChromiumMetrics(
  metrics: readonly { name: string; value: number }[],
): ChromiumPerformanceMetrics {
  const values = new Map(metrics.map((metric) => [metric.name, metric.value]));
  const selected: Record<string, number> = {};
  for (const [cdpName, artifactName] of Object.entries(CDP_METRIC_NAMES)) {
    const value = values.get(cdpName);
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`Performance.getMetrics omitted ${cdpName}`);
    }
    selected[artifactName] = value;
  }
  return selected as unknown as ChromiumPerformanceMetrics;
}

async function collectChromiumPerformanceWithSession(
  cdp: CDPSession,
): Promise<ChromiumPerformanceCapture> {
  try {
    const response = await cdp.send("Performance.getMetrics");
    return {
      capability: SUPPORTED,
      metrics: selectedChromiumMetrics(response.metrics),
    };
  } catch (error) {
    return {
      capability: unavailable(
        `Chromium Performance.getMetrics failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      metrics: null,
    };
  }
}

export async function collectChromiumPerformance(
  page: Page,
): Promise<ChromiumPerformanceCapture> {
  const name = pageBrowserName(page);
  if (name !== "chromium") {
    return {
      capability: unsupported(
        `Playwright ${name} does not expose Chromium Performance.getMetrics`,
      ),
      metrics: null,
    };
  }
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    return collectChromiumPerformanceWithSession(cdp);
  } catch (error) {
    return {
      capability: unavailable(
        `Chromium CDP session failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      metrics: null,
    };
  }
}

function chromiumPerformanceDelta(
  before: ChromiumPerformanceCapture,
  after: ChromiumPerformanceCapture,
): ChromiumPerformanceMetrics | null {
  if (!before.metrics || !after.metrics) return null;
  return Object.fromEntries(
    Object.keys(before.metrics).map((key) => [
      key,
      after.metrics![key as keyof ChromiumPerformanceMetrics] -
        before.metrics![key as keyof ChromiumPerformanceMetrics],
    ]),
  ) as unknown as ChromiumPerformanceMetrics;
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteMetric(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

export function parseServerMetricsSnapshot(
  value: unknown,
  capturedAtUnixMs = Date.now(),
): ServerMetricsSnapshot {
  const root = recordAt(value, "metrics");
  const process = recordAt(root.process, "metrics.process");
  const cache = recordAt(root.session_cache, "metrics.session_cache");
  if (!Array.isArray(root.workers)) throw new Error("metrics.workers must be an array");
  const workers = root.workers.map((worker, index) =>
    recordAt(worker, `metrics.workers[${index}]`),
  );
  const sum = (field: string): number =>
    workers.reduce(
      (total, worker, index) =>
        total + finiteMetric(worker[field], `metrics.workers[${index}].${field}`),
      0,
    );
  return {
    capturedAtUnixMs,
    process: {
      pid: finiteMetric(process.pid, "metrics.process.pid"),
      uptimeSeconds: finiteMetric(process.uptime_s, "metrics.process.uptime_s"),
      goroutines: finiteMetric(process.goroutines, "metrics.process.goroutines"),
      heapAllocBytes: finiteMetric(
        process.heap_alloc_bytes,
        "metrics.process.heap_alloc_bytes",
      ),
      sseClients: finiteMetric(process.sse_clients, "metrics.process.sse_clients"),
      sseGlobalStreams: finiteMetric(
        process.sse_global_streams,
        "metrics.process.sse_global_streams",
      ),
      sseSessionStreams: finiteMetric(
        process.sse_session_streams,
        "metrics.process.sse_session_streams",
      ),
      sseHeartbeats: finiteMetric(
        process.sse_heartbeats,
        "metrics.process.sse_heartbeats",
      ),
      sseWriteErrors: finiteMetric(
        process.sse_write_errors,
        "metrics.process.sse_write_errors",
      ),
      sseFlushErrors: finiteMetric(
        process.sse_flush_errors,
        "metrics.process.sse_flush_errors",
      ),
      watchedFiles: finiteMetric(
        process.watched_files,
        "metrics.process.watched_files",
      ),
    },
    sessionCache: {
      summaryParses: finiteMetric(cache.summary_parses, "metrics.session_cache.summary_parses"),
      summaryHits: finiteMetric(cache.summary_hits, "metrics.session_cache.summary_hits"),
      sessionParses: finiteMetric(cache.session_parses, "metrics.session_cache.session_parses"),
      sessionHits: finiteMetric(cache.session_hits, "metrics.session_cache.session_hits"),
      sessionEntries: finiteMetric(cache.session_entries, "metrics.session_cache.session_entries"),
      sessionBytes: finiteMetric(cache.session_bytes, "metrics.session_cache.session_bytes"),
      sessionEvictions: finiteMetric(
        cache.session_evictions,
        "metrics.session_cache.session_evictions",
      ),
    },
    workers: {
      count: workers.length,
      sampledCount: workers.filter((worker) => worker.sampled === true).length,
      zombieCount: workers.filter((worker) => worker.zombie === true).length,
      rssBytes: sum("rss_bytes"),
      cpuTimeSeconds: sum("cpu_time_s"),
    },
  };
}

export async function collectServerMetrics(
  page: Page,
): Promise<ServerMetricsCapture> {
  try {
    const metricsUrl = /^https?:/.test(page.url())
      ? new URL("/api/metrics", page.url()).toString()
      : "/api/metrics";
    const response = await page.request.get(metricsUrl, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok()) {
      return {
        capability: unavailable(`/api/metrics returned HTTP ${response.status()}`),
        snapshot: null,
      };
    }
    return {
      capability: SUPPORTED,
      snapshot: parseServerMetricsSnapshot(await response.json()),
    };
  } catch (error) {
    return {
      capability: unavailable(
        `/api/metrics snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      snapshot: null,
    };
  }
}

function numericObjectDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key] - before[key]]),
  );
}

export function serverMetricsDelta(
  before: ServerMetricsCapture,
  after: ServerMetricsCapture,
): Record<string, JsonValue> | null {
  if (!before.snapshot || !after.snapshot) return null;
  return {
    intervalMs:
      after.snapshot.capturedAtUnixMs - before.snapshot.capturedAtUnixMs,
    process: numericObjectDelta(
      before.snapshot.process as unknown as Record<string, number>,
      after.snapshot.process as unknown as Record<string, number>,
    ),
    sessionCache: numericObjectDelta(
      before.snapshot.sessionCache as unknown as Record<string, number>,
      after.snapshot.sessionCache as unknown as Record<string, number>,
    ),
    workers: numericObjectDelta(
      before.snapshot.workers as unknown as Record<string, number>,
      after.snapshot.workers as unknown as Record<string, number>,
    ),
  };
}

export async function measureTaskBoundary<T>(
  page: Page,
  name: string,
  action: () => Promise<T>,
): Promise<{ readonly value: T; readonly metrics: TaskBoundaryMetrics }> {
  const serverBefore = await collectServerMetrics(page);
  const chromiumBefore = await collectChromiumPerformance(page);
  const browserBefore = await collectSnapshot(page);
  const value = await action();
  const browserAfter = await collectSnapshot(page);
  const chromiumAfter = await collectChromiumPerformance(page);
  const serverAfter = await collectServerMetrics(page);
  return {
    value,
    metrics: {
      name,
      browser: {
        before: browserBefore,
        after: browserAfter,
        delta: snapshotDelta(browserBefore, browserAfter),
      },
      chromium: {
        before: chromiumBefore,
        after: chromiumAfter,
        // CDP counters reset when navigation swaps the renderer/document. Keep
        // both absolute captures, but only subtract within one time origin.
        delta:
          browserBefore.timeOriginUnixMs === browserAfter.timeOriginUnixMs
            ? chromiumPerformanceDelta(chromiumBefore, chromiumAfter)
            : null,
      },
      server: {
        before: serverBefore,
        after: serverAfter,
        delta: serverMetricsDelta(serverBefore, serverAfter),
      },
    },
  };
}

export async function prepareTemperature(
  page: Page,
  targetPathnameAndQuery: string,
  ready: () => Promise<void>,
): Promise<TemperaturePreparation> {
  if (!targetPathnameAndQuery.startsWith("/")) {
    throw new Error("temperature target must be an origin-relative route");
  }
  if (page.url() !== "about:blank") {
    throw new Error(`temperature setup requires a fresh about:blank page, got ${page.url()}`);
  }
  const configured = temperature();
  if (configured === "cold") {
    return {
      temperature: configured,
      initialPageUrl: "about:blank",
      targetPathnameAndQuery,
      prime: null,
    };
  }

  const response = await page.goto(targetPathnameAndQuery);
  if (!response) throw new Error("warm route prime did not produce a document response");
  if (response.status() < 200 || response.status() > 399) {
    throw new Error(`warm route prime returned HTTP ${response.status()}`);
  }
  await ready();
  const responseUrl = new URL(response.url());
  const pathnameAndQuery = `${responseUrl.pathname}${responseUrl.search}`;
  if (pathnameAndQuery !== targetPathnameAndQuery) {
    throw new Error(
      `warm route prime resolved ${pathnameAndQuery}, expected ${targetPathnameAndQuery}`,
    );
  }
  const prime = {
    pathnameAndQuery,
    responseStatus: response.status(),
    completedAtUnixMs: Date.now(),
  };
  await page.goto("about:blank");
  return {
    temperature: configured,
    initialPageUrl: "about:blank",
    targetPathnameAndQuery,
    prime,
  };
}

export function beginMeasuredTemperatureBoundary(
  preparation: TemperaturePreparation,
): PerfTemperatureSetup {
  const measuredBoundaryStartedAtUnixMs = Date.now();
  if (preparation.temperature === "warm" && preparation.prime === null) {
    throw new Error("warm measurements require completed route-prime evidence");
  }
  return {
    strategy:
      preparation.temperature === "warm"
        ? "warm-primed-route"
        : "cold-unprimed-route",
    targetPathnameAndQuery: preparation.targetPathnameAndQuery,
    initialPageUrl: preparation.initialPageUrl,
    prime: preparation.prime,
    measuredBoundaryStartedAtUnixMs,
  };
}

export async function collectRetainedState(
  page: Page,
): Promise<RetainedStateSnapshot> {
  const browserDom = async () =>
    page.evaluate(() => ({
      domElements: document.getElementsByTagName("*").length,
      visibleTranscriptEntries: document.querySelectorAll(
        '#messages [id^="entry-"]',
      ).length,
    }));
  const name = pageBrowserName(page);
  if (name !== "chromium") {
    return {
      forcedGarbageCollection: unsupported(
        `Playwright ${name} does not expose HeapProfiler.collectGarbage`,
      ),
      browserDom: await browserDom(),
      chromium: {
        capability: unsupported(
          `Playwright ${name} does not expose Chromium Performance.getMetrics`,
        ),
        metrics: null,
      },
    };
  }

  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    return {
      forcedGarbageCollection: SUPPORTED,
      browserDom: await browserDom(),
      chromium: await collectChromiumPerformanceWithSession(cdp),
    };
  } catch (error) {
    return {
      forcedGarbageCollection: unavailable(
        `Chromium forced GC failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      browserDom: await browserDom(),
      chromium: await collectChromiumPerformance(page),
    };
  }
}

function changeRatio(before: number, after: number): number | null {
  if (before === 0) return after === 0 ? 0 : null;
  return (after - before) / before;
}

export function retainedStateDelta(
  before: RetainedStateSnapshot,
  after: RetainedStateSnapshot,
): RetainedStateDelta {
  const beforeChromium = before.chromium.metrics;
  const afterChromium = after.chromium.metrics;
  return {
    domElements: after.browserDom.domElements - before.browserDom.domElements,
    domElementsChangeRatio: changeRatio(
      before.browserDom.domElements,
      after.browserDom.domElements,
    ),
    visibleTranscriptEntries:
      after.browserDom.visibleTranscriptEntries -
      before.browserDom.visibleTranscriptEntries,
    chromium: chromiumPerformanceDelta(before.chromium, after.chromium),
    chromiumNodesChangeRatio:
      beforeChromium && afterChromium
        ? changeRatio(beforeChromium.nodes, afterChromium.nodes)
        : null,
    jsHeapUsedBytesChangeRatio:
      beforeChromium && afterChromium
        ? changeRatio(
            beforeChromium.jsHeapUsedBytes,
            afterChromium.jsHeapUsedBytes,
          )
        : null,
  };
}

function mergeCapabilities(capabilities: readonly Capability[]): Capability {
  if (capabilities.length === 0) return NOT_REQUESTED;
  for (const status of ["unsupported", "unavailable"] as const) {
    const matching = capabilities.filter((capability) => capability.status === status);
    if (matching.length > 0) {
      return {
        status,
        reason: matching.map((capability) => capability.reason).filter(Boolean).join("; "),
      };
    }
  }
  return capabilities.every((capability) => capability.status === "supported")
    ? SUPPORTED
    : NOT_REQUESTED;
}

export function artifactCapabilityEvidence(
  boundaries: readonly TaskBoundaryMetrics[],
  retained: readonly RetainedStateSnapshot[] = [],
): Record<string, Capability> {
  return {
    cdpPerformanceMetrics: mergeCapabilities([
      ...boundaries.flatMap((boundary) => [
        boundary.chromium.before.capability,
        boundary.chromium.after.capability,
      ]),
      ...retained.map((snapshot) => snapshot.chromium.capability),
    ]),
    forcedGarbageCollection: mergeCapabilities(
      retained.map((snapshot) => snapshot.forcedGarbageCollection),
    ),
    serverMetrics: mergeCapabilities(
      boundaries.flatMap((boundary) => [
        boundary.server.before.capability,
        boundary.server.after.capability,
      ]),
    ),
  };
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

function findSnapshots(value: unknown, found: PerfSnapshot[] = []): PerfSnapshot[] {
  if (typeof value !== "object" || value === null) return found;
  if (!Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (
      typeof object.timeOriginUnixMs === "number" &&
      typeof object.nowMs === "number" &&
      typeof object.observerCapabilities === "object" &&
      object.observerCapabilities !== null &&
      typeof object.resources === "object" &&
      object.resources !== null
    ) {
      found.push(value as PerfSnapshot);
      return found;
    }
  }
  for (const child of Object.values(value)) findSnapshots(child, found);
  return found;
}

function capabilityEvidence(
  payload: Record<string, unknown>,
  name: string,
): Capability | null {
  const evidence = payload.capabilityEvidence;
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    return null;
  }
  const value = (evidence as Record<string, unknown>)[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const capability = value as Record<string, unknown>;
  if (
    !["supported", "unsupported", "unavailable", "not-requested"].includes(
      String(capability.status),
    ) ||
    !(capability.reason === null || typeof capability.reason === "string")
  ) {
    return null;
  }
  return capability as unknown as Capability;
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
  const snapshots = findSnapshots(payload);
  const snapshot = snapshots.at(-1);
  const observer = {
    longTasks: snapshots.some((item) => item.observerCapabilities.longTasks),
    layoutShift: snapshots.some((item) => item.observerCapabilities.layoutShift),
    largestContentfulPaint: snapshots.some(
      (item) => item.observerCapabilities.largestContentfulPaint,
    ),
  };
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
      resourceTiming:
        snapshots.length > 0
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
          : (capabilityEvidence(payload, "cdpPerformanceMetrics") ?? NOT_REQUESTED),
      cdpPerformanceMetrics:
        name !== "chromium"
          ? unsupported("Chromium Performance.getMetrics is engine-specific")
          : (capabilityEvidence(payload, "cdpPerformanceMetrics") ?? NOT_REQUESTED),
      forcedGarbageCollection:
        name !== "chromium"
          ? unsupported("Chromium HeapProfiler.collectGarbage is engine-specific")
          : (capabilityEvidence(payload, "forcedGarbageCollection") ?? NOT_REQUESTED),
      serverMetrics:
        capabilityEvidence(payload, "serverMetrics") ??
        unavailable("no /api/metrics snapshot was recorded"),
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
      temperatureSetup: {
        strategy: "cold-unprimed-route",
        targetPathnameAndQuery: "/validation",
        initialPageUrl: "about:blank",
        prime: null,
        measuredBoundaryStartedAtUnixMs: 1,
      },
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
        cdpPerformanceMetrics: NOT_REQUESTED,
        forcedGarbageCollection: NOT_REQUESTED,
        serverMetrics: NOT_REQUESTED,
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
  if (
    typeof payload.temperatureSetup !== "object" ||
    payload.temperatureSetup === null ||
    Array.isArray(payload.temperatureSetup)
  ) {
    throw new Error("performance payload requires checked temperatureSetup evidence");
  }
  const { scenario, temperatureSetup, ...rawMeasurements } = payload;
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
      temperatureSetup,
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
