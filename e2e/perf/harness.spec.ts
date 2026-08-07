import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect, type Page, type TestInfo } from "@playwright/test";
import {
  comparePerformanceResults,
  IncompatiblePerformanceEnvironmentError,
  runComparatorCli,
} from "./compare.ts";
import {
  applyOptionalThrottle,
  beginMeasuredTemperatureBoundary,
  collectChromiumPerformance,
  collectRetainedState,
  collectServerMetrics,
  collectSnapshot,
  installPerformanceObservers,
  parseServerMetricsSnapshot,
  prepareTemperature,
  retainedStateDelta,
  snapshotDelta,
  writePerfArtifact,
  type PerfSnapshot,
} from "./metrics.ts";
import {
  PERF_PROFILE_VERSION,
  PERF_RESULT_KIND,
  PERF_RESULT_SCHEMA_VERSION,
  parsePerfResult,
  parsePerfResultJson,
  type PerfResult,
} from "./result-schema.ts";
import { summarizeSamples } from "./statistics.ts";

test.use({ baseURL: "http://harness.test" });

function result(
  overrides: {
    readonly sampleId?: string;
    readonly viewportWidth?: number;
    readonly timingMs?: number;
  } = {},
): PerfResult {
  return parsePerfResult({
    kind: PERF_RESULT_KIND,
    schemaVersion: PERF_RESULT_SCHEMA_VERSION,
    capturedAt: "2026-01-01T00:00:00.000Z",
    git: { sha: "abcdef123456", dirty: false },
    run: {
      runId: "run-1",
      sampleId: overrides.sampleId ?? "sample-1",
      repetition: 1,
      temperature: "cold",
      temperatureSetup: {
        strategy: "cold-unprimed-route",
        targetPathnameAndQuery: "/harness",
        initialPageUrl: "about:blank",
        prime: null,
        measuredBoundaryStartedAtUnixMs: 2,
      },
    },
    project: "harness Chromium",
    scenario: "harness-scenario",
    environment: {
      os: { platform: "linux", release: "6.1", arch: "x64" },
      nodeVersion: "v22.22.2",
      playwrightVersion: "1.60.0",
      browser: { name: "chromium", version: "123.0" },
      viewport: {
        width: overrides.viewportWidth ?? 393,
        height: 727,
        deviceScaleFactor: 2.75,
      },
      headless: true,
      profile: {
        id: "unthrottled-local",
        version: PERF_PROFILE_VERSION,
        parameters: {
          latencyMs: null,
          downloadBytesPerSecond: null,
          uploadBytesPerSecond: null,
          cpuSlowdownFactor: null,
        },
      },
      capabilities: Object.fromEntries(
        [
          "cdp",
          "networkThrottling",
          "cpuThrottling",
          "resourceTiming",
          "longTasks",
          "layoutShift",
          "largestContentfulPaint",
          "performanceMemory",
          "chromiumMemory",
          "cdpPerformanceMetrics",
          "forcedGarbageCollection",
          "serverMetrics",
        ].map((name) => [name, { status: "supported", reason: null }]),
      ),
    },
    measurements: { task: { renderMs: overrides.timingMs ?? 100 } },
  });
}

function results(timingsMs: readonly number[], prefix: string): PerfResult[] {
  return timingsMs.map((timingMs, index) =>
    result({ sampleId: `${prefix}-${index + 1}`, timingMs }),
  );
}

function snapshot(overrides: Partial<PerfSnapshot> = {}): PerfSnapshot {
  return {
    timeOriginUnixMs: 1_000,
    nowMs: 10,
    navigation: null,
    paints: [],
    largestContentfulPaintMs: null,
    cumulativeLayoutShift: 0,
    longTasks: [],
    longTasksTruncated: false,
    observerCapabilities: {
      longTasks: true,
      layoutShift: true,
      largestContentfulPaint: true,
    },
    resources: {
      count: 0,
      transferBytes: 0,
      decodedBytes: 0,
      entries: [],
      entriesTruncated: false,
      byKind: {},
    },
    domElements: 10,
    visibleTranscriptEntries: 2,
    jsHeapUsedBytes: 1_000,
    ...overrides,
  };
}

function fakeTestInfo(root: string): TestInfo {
  let attachmentSequence = 0;
  return {
    title: "artifact contract",
    testId: "artifact-contract",
    repeatEachIndex: 0,
    project: {
      name: "Harness Chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 393, height: 727 },
        deviceScaleFactor: 2.75,
        headless: true,
      },
    },
    outputPath: (name: string) => resolve(root, "attachments", name),
    attach: async () => {
      attachmentSequence += 1;
    },
  } as unknown as TestInfo;
}

test("validates the checked versioned result contract", () => {
  expect(parsePerfResult(result())).toEqual(result());
  expect(() => parsePerfResult({ ...result(), schemaVersion: 1 })).toThrow(
    /schemaVersion/,
  );
  expect(() =>
    parsePerfResult({
      ...result(),
      environment: {
        ...result().environment,
        viewport: { width: 0, height: 727, deviceScaleFactor: 2.75 },
      },
    }),
  ).toThrow(/viewport.width/);
  expect(() =>
    parsePerfResult({
      ...result(),
      environment: {
        ...result().environment,
        capabilities: {
          ...result().environment.capabilities,
          cdpPerformanceMetrics: { status: "unsupported", reason: null },
        },
      },
    }),
  ).toThrow(/cdpPerformanceMetrics.reason.*require a reason/);
});

test("requires temperature setup to prove cold and warm semantics", () => {
  const cold = result();
  expect(cold.run.temperatureSetup).toMatchObject({
    strategy: "cold-unprimed-route",
    prime: null,
  });
  expect(() =>
    parsePerfResult({
      ...cold,
      run: {
        ...cold.run,
        temperature: "warm",
      },
    }),
  ).toThrow(/warm samples must use the primed-route strategy/);

  const warm = parsePerfResult({
    ...cold,
    run: {
      ...cold.run,
      temperature: "warm",
      temperatureSetup: {
        strategy: "warm-primed-route",
        targetPathnameAndQuery: "/session?id=warm",
        initialPageUrl: "about:blank",
        prime: {
          pathnameAndQuery: "/session?id=warm",
          responseStatus: 200,
          completedAtUnixMs: 10,
        },
        measuredBoundaryStartedAtUnixMs: 11,
      },
    },
  });
  expect(warm.run.temperatureSetup.prime).toMatchObject({ responseStatus: 200 });
  expect(() =>
    parsePerfResult({
      ...warm,
      run: {
        ...warm.run,
        temperatureSetup: {
          ...warm.run.temperatureSetup,
          measuredBoundaryStartedAtUnixMs: 9,
        },
      },
    }),
  ).toThrow(/must follow warm-route priming/);
});

test("warm setup primes the exact route before the measured boundary", async ({
  page,
}) => {
  const previousTemperature = process.env.PICAN_PERF_TEMPERATURE;
  process.env.PICAN_PERF_TEMPERATURE = "warm";
  let documentRequests = 0;
  await page.route("http://harness.test/**", async (route) => {
    documentRequests += 1;
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><div id=ready>ready</div>",
    });
  });
  try {
    const preparation = await prepareTemperature(
      page,
      "/warm?resource=route",
      async () => page.locator("#ready").waitFor(),
    );
    const proof = beginMeasuredTemperatureBoundary(preparation);
    expect(documentRequests).toBe(1);
    expect(page.url()).toBe("about:blank");
    expect(proof).toMatchObject({
      strategy: "warm-primed-route",
      targetPathnameAndQuery: "/warm?resource=route",
      prime: {
        pathnameAndQuery: "/warm?resource=route",
        responseStatus: 200,
      },
    });
    expect(proof.prime!.completedAtUnixMs).toBeLessThanOrEqual(
      proof.measuredBoundaryStartedAtUnixMs,
    );
  } finally {
    if (previousTemperature === undefined) delete process.env.PICAN_PERF_TEMPERATURE;
    else process.env.PICAN_PERF_TEMPERATURE = previousTemperature;
  }
});

test("writes unique validated artifact paths for repeated samples", async () => {
  const root = mkdtempSync(join(tmpdir(), "pican-perf-harness-"));
  const previousOutput = process.env.PICAN_PERF_OUTPUT_DIR;
  process.env.PICAN_PERF_OUTPUT_DIR = resolve(root, "results");
  try {
    const testInfo = fakeTestInfo(root);
    const temperatureSetup = {
      strategy: "cold-unprimed-route",
      targetPathnameAndQuery: "/artifact-contract",
      initialPageUrl: "about:blank",
      prime: null,
      measuredBoundaryStartedAtUnixMs: 2,
    } as const;
    const first = await writePerfArtifact(testInfo, {
      scenario: "artifact-contract",
      temperatureSetup,
      task: { renderMs: 10 },
    });
    const second = await writePerfArtifact(testInfo, {
      scenario: "artifact-contract",
      temperatureSetup,
      task: { renderMs: 11 },
    });
    expect(first).not.toBe(second);
    const firstResult = parsePerfResultJson(readFileSync(first, "utf8"));
    const secondResult = parsePerfResultJson(readFileSync(second, "utf8"));
    expect(firstResult.run.runId).toBe(secondResult.run.runId);
    expect(firstResult.run.sampleId).not.toBe(secondResult.run.sampleId);
    expect(firstResult.environment.viewport).toEqual({
      width: 393,
      height: 727,
      deviceScaleFactor: 2.75,
    });
  } finally {
    if (previousOutput === undefined) delete process.env.PICAN_PERF_OUTPUT_DIR;
    else process.env.PICAN_PERF_OUTPUT_DIR = previousOutput;
    rmSync(root, { recursive: true, force: true });
  }
});

test("computes median, nearest-rank p95, and max", () => {
  const samples = Array.from({ length: 20 }, (_, index) => index + 1);
  expect(summarizeSamples(samples)).toEqual({
    count: 20,
    median: 10.5,
    p95: 19,
    max: 20,
  });
});

test("reports the CDP profile as unsupported without calling CDP on WebKit", async () => {
  const previousProfile = process.env.PICAN_PERF_PROFILE;
  process.env.PICAN_PERF_PROFILE = "mobile4g";
  let attemptedCdp = false;
  const webkitPage = {
    context: () => ({
      browser: () => ({ browserType: () => ({ name: () => "webkit" }) }),
      newCDPSession: () => {
        attemptedCdp = true;
        throw new Error("CDP must not be attempted for WebKit");
      },
    }),
  } as unknown as Page;
  try {
    const application = await applyOptionalThrottle(webkitPage);
    expect(attemptedCdp).toBe(false);
    expect(application.cdpSession).toBeNull();
    expect(application.profile).toMatchObject({ id: "mobile4g", version: 1 });
    expect(application.capabilities).toMatchObject({
      cdp: { status: "unsupported" },
      networkThrottling: { status: "unsupported" },
      cpuThrottling: { status: "unsupported" },
    });
  } finally {
    if (previousProfile === undefined) delete process.env.PICAN_PERF_PROFILE;
    else process.env.PICAN_PERF_PROFILE = previousProfile;
  }
});

test("maps the fixed Chromium CPU, DOM, layout, and heap metric set", async () => {
  const names = [
    "Timestamp",
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "LayoutCount",
    "RecalcStyleCount",
    "Nodes",
    "Documents",
    "Frames",
    "JSEventListeners",
    "JSHeapUsedSize",
    "JSHeapTotalSize",
  ];
  const calls: string[] = [];
  const chromiumPage = {
    context: () => ({
      browser: () => ({ browserType: () => ({ name: () => "chromium" }) }),
      newCDPSession: async () => ({
        send: async (method: string) => {
          calls.push(method);
          return method === "Performance.getMetrics"
            ? {
                metrics: names.map((name, index) => ({ name, value: index + 1 })),
              }
            : {};
        },
      }),
    }),
  } as unknown as Page;

  const captured = await collectChromiumPerformance(chromiumPage);
  expect(calls).toEqual(["Performance.enable", "Performance.getMetrics"]);
  expect(captured).toEqual({
    capability: { status: "supported", reason: null },
    metrics: {
      timestampSeconds: 1,
      taskDurationSeconds: 2,
      scriptDurationSeconds: 3,
      layoutDurationSeconds: 4,
      recalcStyleDurationSeconds: 5,
      layoutCount: 6,
      recalcStyleCount: 7,
      nodes: 8,
      documents: 9,
      frames: 10,
      jsEventListeners: 11,
      jsHeapUsedBytes: 12,
      jsHeapTotalBytes: 13,
    },
  });
});

test("marks Chromium metrics and forced GC unsupported without attempting CDP on WebKit", async () => {
  let attemptedCdp = false;
  const webkitPage = {
    context: () => ({
      browser: () => ({ browserType: () => ({ name: () => "webkit" }) }),
      newCDPSession: () => {
        attemptedCdp = true;
        throw new Error("CDP must not be attempted for WebKit");
      },
    }),
    evaluate: async () => ({ domElements: 12, visibleTranscriptEntries: 3 }),
  } as unknown as Page;

  const performanceMetrics = await collectChromiumPerformance(webkitPage);
  const retained = await collectRetainedState(webkitPage);
  expect(attemptedCdp).toBe(false);
  expect(performanceMetrics).toEqual({
    capability: expect.objectContaining({ status: "unsupported" }),
    metrics: null,
  });
  expect(retained).toMatchObject({
    forcedGarbageCollection: { status: "unsupported" },
    browserDom: { domElements: 12, visibleTranscriptEntries: 3 },
    chromium: {
      capability: { status: "unsupported" },
      metrics: null,
    },
  });
});

test("marks an unavailable server metrics endpoint without fabricating a snapshot", async () => {
  const unavailablePage = {
    url: () => "about:blank",
    request: {
      get: async () => ({ ok: () => false, status: () => 503 }),
    },
  } as unknown as Page;
  await expect(collectServerMetrics(unavailablePage)).resolves.toEqual({
    capability: {
      status: "unavailable",
      reason: "/api/metrics returned HTTP 503",
    },
    snapshot: null,
  });
});

test("collects bounded server metric snapshots without worker identifiers", () => {
  const captured = parseServerMetricsSnapshot(
    {
      process: {
        pid: 42,
        uptime_s: 10,
        goroutines: 5,
        heap_alloc_bytes: 1_000,
        sse_clients: 2,
        sse_global_streams: 1,
        sse_session_streams: 1,
        sse_heartbeats: 3,
        sse_write_errors: 0,
        sse_flush_errors: 0,
        watched_files: 4,
      },
      session_cache: {
        summary_parses: 7,
        summary_hits: 6,
        session_parses: 5,
        session_hits: 4,
        session_entries: 3,
        session_bytes: 2_000,
        session_evictions: 2,
      },
      workers: [
        {
          session_id: "must-not-leak",
          sampled: true,
          zombie: false,
          rss_bytes: 100,
          cpu_time_s: 2,
        },
        {
          session_id: "also-private",
          sampled: false,
          zombie: true,
          rss_bytes: 50,
          cpu_time_s: 1,
        },
      ],
    },
    123,
  );
  expect(captured).toMatchObject({
    capturedAtUnixMs: 123,
    process: { pid: 42, heapAllocBytes: 1_000 },
    workers: {
      count: 2,
      sampledCount: 1,
      zombieCount: 1,
      rssBytes: 150,
      cpuTimeSeconds: 3,
    },
  });
  expect(JSON.stringify(captured)).not.toContain("must-not-leak");
  expect(JSON.stringify(captured)).not.toContain("also-private");
});

test("attributes pathname plus query and computes task-boundary deltas", async ({
  page,
}) => {
  await installPerformanceObservers(page);
  await page.route("http://harness.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/items") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>performance harness</title>",
    });
  });
  await page.goto("http://harness.test/");
  await page.evaluate(async () => {
    await fetch("/api/items?cursor=next&page=2").then((response) =>
      response.text(),
    );
  });
  const measured = await collectSnapshot(page);
  expect(measured.resources.entries).toContainEqual(
    expect.objectContaining({
      pathnameAndQuery: "/api/items?cursor=next&page=2",
      initiatorType: "fetch",
    }),
  );

  const before = snapshot();
  const resource = {
    pathnameAndQuery: "/api/items?cursor=next&page=2",
    initiatorType: "fetch",
    transferBytes: 120,
    decodedBytes: 80,
    startTime: 12,
    duration: 2,
  };
  const after = snapshot({
    nowMs: 20,
    longTasks: [{ startTime: 14, duration: 5 }],
    resources: {
      count: 1,
      transferBytes: 120,
      decodedBytes: 80,
      entries: [resource],
      entriesTruncated: false,
      byKind: {},
    },
    domElements: 14,
    visibleTranscriptEntries: 3,
    jsHeapUsedBytes: 1_250,
  });
  expect(snapshotDelta(before, after)).toEqual({
    boundary: { startMs: 1010, endMs: 1020, durationMs: 10 },
    longTasks: {
      count: 1,
      totalDurationMs: 5,
      maxDurationMs: 5,
      entries: [{ startTime: 14, duration: 5 }],
    },
    resources: {
      count: 1,
      transferBytes: 120,
      decodedBytes: 80,
      entries: [resource],
    },
    domElementsDelta: 4,
    visibleTranscriptEntriesDelta: 1,
    jsHeapUsedBytesDelta: 250,
  });
});

test("computes retained DOM growth and leaves unsupported heap ratios null", () => {
  const capability = {
    status: "unsupported",
    reason: "non-Chromium test fixture",
  } as const;
  const before = {
    forcedGarbageCollection: capability,
    browserDom: { domElements: 100, visibleTranscriptEntries: 20 },
    chromium: { capability, metrics: null },
  };
  const after = {
    forcedGarbageCollection: capability,
    browserDom: { domElements: 110, visibleTranscriptEntries: 25 },
    chromium: { capability, metrics: null },
  };
  expect(retainedStateDelta(before, after)).toEqual({
    domElements: 10,
    domElementsChangeRatio: 0.1,
    visibleTranscriptEntries: 5,
    chromium: null,
    chromiumNodesChangeRatio: null,
    jsHeapUsedBytesChangeRatio: null,
  });
});

test("passes accepted median, p95, and max distribution gates", () => {
  const comparison = comparePerformanceResults(
    results(Array(20).fill(100), "base"),
    results(Array(20).fill(110), "candidate"),
    { baselineAccepted: true },
  );

  expect(comparison).toMatchObject({
    status: "passed",
    maxMedianRegressionRatio: 0.1,
    maxP95RegressionRatio: 0.2,
    maxMaxRegressionRatio: 0.25,
  });
  expect(comparison.comparisons[0]).toMatchObject({
    baseline: { median: 100, p95: 100, max: 100 },
    candidate: { median: 110, p95: 110, max: 110 },
    median: {
      baseline: 100,
      candidate: 110,
      changeRatio: 0.1,
      maxRegressionRatio: 0.1,
      verdict: "passed",
    },
    p95: { changeRatio: 0.1, verdict: "passed" },
    max: { changeRatio: 0.1, verdict: "passed" },
    medianChangeRatio: 0.1,
    regressed: false,
  });
});

test("fails each accepted distribution gate independently", () => {
  const baseline = results(Array(20).fill(100), "base");
  const cases = [
    {
      samples: Array(20).fill(111),
      verdicts: { median: "failed", p95: "passed", max: "passed" },
    },
    {
      samples: [...Array(18).fill(100), 121, 121],
      verdicts: { median: "passed", p95: "failed", max: "passed" },
    },
    {
      samples: [...Array(19).fill(100), 126],
      verdicts: { median: "passed", p95: "passed", max: "failed" },
    },
  ] as const;

  for (const [index, testCase] of cases.entries()) {
    const comparison = comparePerformanceResults(
      baseline,
      results(testCase.samples, `candidate-${index}`),
      { baselineAccepted: true },
    );
    const metric = comparison.comparisons[0];
    expect(comparison.status).toBe("failed");
    expect({
      median: metric.median.verdict,
      p95: metric.p95.verdict,
      max: metric.max.verdict,
    }).toEqual(testCase.verdicts);
  }
});

test("applies explicit distribution threshold overrides", () => {
  const comparison = comparePerformanceResults(
    results(Array(20).fill(100), "base"),
    results(Array(20).fill(126), "candidate"),
    {
      baselineAccepted: true,
      maxMedianRegressionRatio: 0.3,
      maxP95RegressionRatio: 0.3,
      maxMaxRegressionRatio: 0.3,
    },
  );

  expect(comparison.status).toBe("passed");
  expect(comparison.comparisons[0]).toMatchObject({
    median: { maxRegressionRatio: 0.3, verdict: "passed" },
    p95: { maxRegressionRatio: 0.3, verdict: "passed" },
    max: { maxRegressionRatio: 0.3, verdict: "passed" },
  });
});

test("handles zero baselines explicitly", () => {
  const baseline = results(Array(20).fill(0), "base");
  const failed = comparePerformanceResults(
    baseline,
    results(Array(20).fill(1), "candidate"),
    { baselineAccepted: true },
  );

  expect(failed.status).toBe("failed");
  expect(failed.comparisons[0]).toMatchObject({
    median: { changeRatio: null, verdict: "failed" },
    p95: { changeRatio: null, verdict: "failed" },
    max: { changeRatio: null, verdict: "failed" },
    medianChangeRatio: null,
    regressed: true,
  });

  const passed = comparePerformanceResults(
    baseline,
    results(Array(20).fill(0), "unchanged"),
    { baselineAccepted: true },
  );
  expect(passed.status).toBe("passed");
  expect(passed.comparisons[0]).toMatchObject({
    median: { changeRatio: 0, verdict: "passed" },
    p95: { changeRatio: 0, verdict: "passed" },
    max: { changeRatio: 0, verdict: "passed" },
  });
});

test("keeps all unaccepted distribution verdicts informational", () => {
  const comparison = comparePerformanceResults(
    results(Array(20).fill(100), "base"),
    results(Array(20).fill(200), "candidate"),
  );
  const metric = comparison.comparisons[0];

  expect(comparison.status).toBe("provisional");
  expect(metric.regressed).toBe(true);
  expect([
    metric.median.verdict,
    metric.p95.verdict,
    metric.max.verdict,
  ]).toEqual(["informational", "informational", "informational"]);
});

test("includes all distribution thresholds in CLI usage", () => {
  expect(() => runComparatorCli([])).toThrow(
    /--max-median-regression.*--max-p95-regression.*--max-max-regression/,
  );
});

test("refuses environment mismatches", () => {
  expect(() =>
    comparePerformanceResults(
      [result({ sampleId: "base-1" })],
      [result({ sampleId: "candidate-1", viewportWidth: 390 })],
    ),
  ).toThrow(IncompatiblePerformanceEnvironmentError);
});
