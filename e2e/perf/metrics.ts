import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CDPSession, Page, TestInfo } from "@playwright/test";

export interface PerfSnapshot {
  readonly nowMs: number;
  readonly navigation: Record<string, number> | null;
  readonly paints: readonly { name: string; startTime: number }[];
  readonly largestContentfulPaintMs: number | null;
  readonly cumulativeLayoutShift: number;
  readonly longTasks: readonly { startTime: number; duration: number }[];
  readonly resources: {
    readonly count: number;
    readonly transferBytes: number;
    readonly decodedBytes: number;
    readonly byKind: Record<
      string,
      { count: number; transferBytes: number; decodedBytes: number }
    >;
  };
  readonly domElements: number;
  readonly visibleTranscriptEntries: number;
  readonly jsHeapUsedBytes: number | null;
}

export async function installPerformanceObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      longTasks: [] as { startTime: number; duration: number }[],
      layoutShift: 0,
      largestContentfulPaint: null as number | null,
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
      // Entry type is not supported by every engine.
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
      // Entry type is not supported by every engine.
    }
    try {
      new PerformanceObserver((list) => {
        const latest = list.getEntries().at(-1);
        if (latest) state.largestContentfulPaint = latest.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      // Entry type is not supported by every engine.
    }
  });
}

export async function applyOptionalThrottle(
  page: Page,
): Promise<CDPSession | null> {
  if (process.env.PICAN_PERF_PROFILE !== "mobile4g") return null;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: 500_000,
    uploadThroughput: 250_000,
    connectionType: "cellular4g",
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  return cdp;
}

export async function collectSnapshot(page: Page): Promise<PerfSnapshot> {
  return page.evaluate(() => {
    type PerfState = {
      longTasks: { startTime: number; duration: number }[];
      layoutShift: number;
      largestContentfulPaint: number | null;
    };
    const state = (window as unknown as { __picanPerf?: PerfState })
      .__picanPerf;
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const resources = performance.getEntriesByType(
      "resource",
    ) as PerformanceResourceTiming[];
    const byKind: Record<
      string,
      { count: number; transferBytes: number; decodedBytes: number }
    > = {};
    for (const resource of resources) {
      const path = new URL(resource.name).pathname;
      const kind = path.startsWith("/api/")
        ? path
        : path.endsWith(".js")
          ? "script"
          : path.endsWith(".css")
            ? "style"
            : path;
      const bucket = (byKind[kind] ??= {
        count: 0,
        transferBytes: 0,
        decodedBytes: 0,
      });
      bucket.count += 1;
      bucket.transferBytes += resource.transferSize;
      bucket.decodedBytes += resource.decodedBodySize;
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
      resources: {
        count: resources.length,
        transferBytes: resources.reduce(
          (sum, resource) => sum + resource.transferSize,
          0,
        ),
        decodedBytes: resources.reduce(
          (sum, resource) => sum + resource.decodedBodySize,
          0,
        ),
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

export async function collectChromiumMemory(
  page: Page,
): Promise<Record<string, number> | null> {
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

export async function writePerfArtifact(
  testInfo: TestInfo,
  payload: Record<string, unknown>,
): Promise<string> {
  const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim() !== "";
  const artifact = {
    schemaVersion: 1,
    git: { sha, dirty },
    capturedAt: new Date().toISOString(),
    project: testInfo.project.name,
    profile: process.env.PICAN_PERF_PROFILE ?? "unthrottled-local",
    ...payload,
  };
  const json = JSON.stringify(artifact, null, 2) + "\n";
  const attachmentPath = testInfo.outputPath("metrics.json");
  writeFileSync(attachmentPath, json);
  await testInfo.attach("performance-metrics", {
    path: attachmentPath,
    contentType: "application/json",
  });

  const outputDir = resolve(
    process.cwd(),
    process.env.PICAN_PERF_OUTPUT_DIR ?? "perf-results",
  );
  mkdirSync(outputDir, { recursive: true });
  const profile = (process.env.PICAN_PERF_PROFILE ?? "unthrottled-local")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const resultPath = resolve(outputDir, `${sha}-${profile}-${slug}.json`);
  writeFileSync(resultPath, json);
  return resultPath;
}
