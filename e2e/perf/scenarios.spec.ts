import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import { appendEntry } from "../lib/sessions";
import { generateCatalogFixture, generateTranscriptFixture } from "./fixtures";
import {
  applyOptionalThrottle,
  artifactCapabilityEvidence,
  beginMeasuredTemperatureBoundary,
  collectRetainedState,
  installPerformanceObservers,
  measureTaskBoundary,
  prepareTemperature,
  retainedStateDelta,
  writePerfArtifact,
} from "./metrics";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installPerformanceObservers(page);
  await applyOptionalThrottle(page);
});

test("bounded V3 project, session, and pinned switching", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pican-perf-projects-"));
  const projectPaths = Array.from({ length: 5 }, (_, index) => {
    const path = join(projectRoot, `project-${index}`);
    mkdirSync(path, { recursive: true });
    return path;
  });
  const fixture = generateCatalogFixture({
    sessionsDir,
    projectPaths,
    sessionsPerProject: 12,
  });
  const pinnedSessionIds = fixture.sessionIds.slice(0, 10);
  const sessionFile = (id: string) => join(sessionsDir, "--home-user-demo-project--", id);

  await page.addInitScript(() => {
    localStorage.setItem("pican:v1:session-tabs", "true");
  });
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ settings: { "pican:v1:session-tabs": "true" } }),
    });
  });

  try {
    // The server's recent-mtime fallback briefly classifies newly written
    // fixtures as running. The generator backdates mtimes; let the status
    // sweeper publish the corresponding idle transition before measuring.
    await page.waitForTimeout(2_000);
    for (const path of projectPaths) {
      const response = await page.request.post("/api/projects", {
        data: { action: "track", path },
      });
      expect(response.ok()).toBeTruthy();
    }
    for (const sessionId of pinnedSessionIds) {
      const response = await page.request.post("/api/pins", {
        data: { sessionId, pinned: true },
      });
      expect(response.ok()).toBeTruthy();
    }

    const preparation = await prepareTemperature(page, "/", async () => {
      await expect(page.locator(".activity-row").first()).toBeVisible();
    });
    const temperatureSetup = beginMeasuredTemperatureBoundary(preparation);
    const initialMeasured = await measureTaskBoundary(page, "home-initial-load", async () => {
      const startedAt = performance.now();
      const sessionsResponse = page.waitForResponse((response) =>
        response.url().includes("/api/sessions?view=home"),
      );
      const projectsResponse = page.waitForResponse((response) =>
        response.url().includes("/api/projects"),
      );
      await page.goto("/");
      await Promise.all([sessionsResponse, projectsResponse]);
      await expect(page.locator(".activity-row").first()).toBeVisible();
      const firstRowMs = performance.now() - startedAt;
      const rowCount = await page.locator(".activity-row").count();
      const projectCount = await page.locator(".activity-group--project[data-project]").count();
      await expect(page.locator('[data-bucket="pinned"] .activity-row')).toHaveCount(8);
      await expect(page.locator('[data-bucket="pinned"] .activity-group-action')).toContainText(
        "10",
      );
      expect(projectCount).toBe(5);
      expect(rowCount).toBeLessThanOrEqual(40);
      return { firstRowMs, rowCount, projectCount, visiblePins: 8 };
    });

    const documentIdentity = await page.evaluate(() => {
      const identity = crypto.randomUUID();
      const markedWindow = window as Window & { __v3PerfDocument?: string };
      markedWindow.__v3PerfDocument = identity;
      return {
        identity,
        navigationCount: performance.getEntriesByType("navigation").length,
      };
    });
    const sameDocument = () =>
      page.evaluate(() => {
        const markedWindow = window as Window & { __v3PerfDocument?: string };
        return {
          identity: markedWindow.__v3PerfDocument,
          navigationCount: performance.getEntriesByType("navigation").length,
        };
      });

    const projectRequests: string[] = [];
    const targetProject = projectPaths[0];
    const trackProjectRequest = (request: import("@playwright/test").Request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/sessions" && url.searchParams.get("project") === targetProject) {
        projectRequests.push(request.url());
      }
    };
    page.on("request", trackProjectRequest);
    const projectMeasured = await measureTaskBoundary(page, "project-spa-switch", async () => {
      const startedAt = performance.now();
      const response = page.waitForResponse((candidate) => {
        const url = new URL(candidate.url());
        return (
          url.pathname === "/api/sessions" && url.searchParams.get("project") === targetProject
        );
      });
      await page
        .locator(`.activity-group--project[data-project="${targetProject}"] h3 a`)
        .dispatchEvent("click");
      await response;
      await expect(page.locator('[data-sessions-content][data-scope="project"]')).toBeVisible();
      return { projectSwitchMs: performance.now() - startedAt };
    });
    page.off("request", trackProjectRequest);
    expect(projectRequests).toHaveLength(1);
    expect(await sameDocument()).toEqual(documentIdentity);

    const initialSessionId = pinnedSessionIds[0];
    const isPaginatedSessionRequest = (rawURL: string, id: string) => {
      const url = new URL(rawURL);
      return (
        url.pathname === "/api/session" &&
        url.searchParams.get("id") === id &&
        url.searchParams.get("paginate") === "1"
      );
    };
    const initialSessionRequests: string[] = [];
    const trackInitialSession = (request: import("@playwright/test").Request) => {
      if (isPaginatedSessionRequest(request.url(), initialSessionId)) {
        initialSessionRequests.push(request.url());
      }
    };
    page.on("request", trackInitialSession);
    const sessionMeasured = await measureTaskBoundary(page, "session-prefetch-switch", async () => {
      const startedAt = performance.now();
      const link = page.locator(`.activity-row[data-session-id="${initialSessionId}"] a`).first();
      const prefetched = page.waitForResponse((response) =>
        isPaginatedSessionRequest(response.url(), initialSessionId),
      );
      await link.dispatchEvent("touchstart");
      await prefetched;
      await link.dispatchEvent("click");
      await expect(page).toHaveURL(new RegExp(`id=${encodeURIComponent(initialSessionId)}`));
      await expect(page.locator('#messages [id^="entry-"]').first()).toBeAttached();
      return { sessionSwitchMs: performance.now() - startedAt };
    });
    page.off("request", trackInitialSession);
    expect(initialSessionRequests).toHaveLength(1);
    expect(await sameDocument()).toEqual(documentIdentity);

    type RawMetrics = {
      process: {
        sse_clients: number;
        sse_global_streams: number;
        sse_session_streams: number;
      };
    };
    const readSseOwnership = async () => {
      const response = await page.request.get("/api/metrics");
      expect(response.ok()).toBeTruthy();
      const metrics = (await response.json()) as RawMetrics;
      return metrics.process;
    };
    await expect.poll(async () => (await readSseOwnership()).sse_session_streams).toBe(1);

    // Measure steady-state retention after a complete ten-switch cycle. This
    // excludes bounded module/resource caches while every measured switch still
    // performs its real fetch, mount, and stream handoff.
    for (let warmIndex = 0; warmIndex < 10; warmIndex += 1) {
      const targetId = pinnedSessionIds[warmIndex % 2 === 0 ? 1 : 0];
      const link = page.locator(`.pinned-chip[data-session-id="${targetId}"] > a`);
      const prefetched = page.waitForResponse((response) =>
        isPaginatedSessionRequest(response.url(), targetId),
      );
      await link.dispatchEvent("touchstart");
      await prefetched;
      await link.dispatchEvent("click");
      await expect(page).toHaveURL(new RegExp(`id=${encodeURIComponent(targetId)}`));
      await expect(page.locator('#messages [id^="entry-"]').first()).toBeAttached();
      await expect.poll(async () => (await readSseOwnership()).sse_session_streams).toBe(1);
    }
    const retainedBeforeSwitches = await collectRetainedState(page);
    const pinnedRequestCounts: number[] = [];
    const sseOwnership: RawMetrics["process"][] = [];
    const pinnedMeasured = await measureTaskBoundary(page, "pinned-ten-switches", async () => {
      const switchTimingsMs: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        const targetId = pinnedSessionIds[index % 2 === 0 ? 1 : 0];
        const requests: string[] = [];
        const trackRequest = (request: import("@playwright/test").Request) => {
          if (isPaginatedSessionRequest(request.url(), targetId)) requests.push(request.url());
        };
        page.on("request", trackRequest);
        const startedAt = performance.now();
        const link = page.locator(`.pinned-chip[data-session-id="${targetId}"] > a`);
        await expect(link).toBeVisible();
        const prefetched = page.waitForResponse(
          (response) => isPaginatedSessionRequest(response.url(), targetId),
          { timeout: 10_000 },
        );
        await link.dispatchEvent(index % 2 === 0 ? "touchstart" : "pointerenter");
        await prefetched;
        // Dispatch navigation without moving the emulated mouse onto the
        // replacement chip, which could otherwise start the next prefetch
        // before its measured boundary is installed.
        await link.dispatchEvent("click");
        await expect(page).toHaveURL(new RegExp(`id=${encodeURIComponent(targetId)}`));
        await expect(page.locator('#messages [id^="entry-"]').first()).toBeAttached();
        switchTimingsMs.push(performance.now() - startedAt);
        page.off("request", trackRequest);
        pinnedRequestCounts.push(requests.length);
        await expect.poll(async () => (await readSseOwnership()).sse_session_streams).toBe(1);
        const ownership = await readSseOwnership();
        expect(ownership.sse_clients).toBe(
          ownership.sse_global_streams + ownership.sse_session_streams,
        );
        sseOwnership.push(ownership);
      }
      return {
        pinnedSwitchTotalMs: switchTimingsMs.reduce((sum, value) => sum + value, 0),
        switchTimingsMs,
      };
    });
    expect(pinnedRequestCounts).toEqual(Array(10).fill(1));
    expect(await sameDocument()).toEqual(documentIdentity);

    await page.waitForTimeout(1_000);
    const retainedAfterSwitches = await collectRetainedState(page);
    const switchRetainedDelta = retainedStateDelta(retainedBeforeSwitches, retainedAfterSwitches);
    console.log("[perf] V3 retained delta", JSON.stringify(switchRetainedDelta));
    expect(Math.abs(switchRetainedDelta.domElementsChangeRatio ?? Infinity)).toBeLessThanOrEqual(
      0.1,
    );
    expect(
      Math.abs(switchRetainedDelta.jsHeapUsedBytesChangeRatio ?? Infinity),
    ).toBeLessThanOrEqual(0.1);

    const boundaries = [
      initialMeasured.metrics,
      projectMeasured.metrics,
      sessionMeasured.metrics,
      pinnedMeasured.metrics,
    ];
    const retained = [retainedBeforeSwitches, retainedAfterSwitches];
    const resultPath = await writePerfArtifact(testInfo, {
      scenario: "bounded-v3-switching",
      temperatureSetup,
      capabilityEvidence: artifactCapabilityEvidence(boundaries, retained),
      fixture: {
        projects: projectPaths.length,
        sessions: fixture.sessionIds.length,
        pins: pinnedSessionIds.length,
        serializedBytes: fixture.serializedBytes,
      },
      task: {
        ...initialMeasured.value,
        ...projectMeasured.value,
        ...sessionMeasured.value,
        ...pinnedMeasured.value,
        requestCounts: {
          project: projectRequests.length,
          session: initialSessionRequests.length,
          pinned: pinnedRequestCounts,
        },
      },
      boundaries: {
        initialLoad: initialMeasured.metrics,
        projectSwitch: projectMeasured.metrics,
        sessionSwitch: sessionMeasured.metrics,
        pinnedTenSwitches: pinnedMeasured.metrics,
      },
      sseOwnership,
      retained: {
        beforeTenSwitchesForcedGc: retainedBeforeSwitches,
        afterTenSwitchesForcedGc: retainedAfterSwitches,
        tenSwitchDelta: switchRetainedDelta,
      },
    });
    console.log(
      `[perf] V3 switching: home ${initialMeasured.value.firstRowMs.toFixed(1)}ms, project ${projectMeasured.value.projectSwitchMs.toFixed(1)}ms, session ${sessionMeasured.value.sessionSwitchMs.toFixed(1)}ms, 10 pins ${pinnedMeasured.value.pinnedSwitchTotalMs.toFixed(1)}ms -> ${resultPath}`,
    );
  } finally {
    for (const sessionId of pinnedSessionIds) {
      await page.request.post("/api/pins", { data: { sessionId, pinned: false } }).catch(() => {});
    }
    for (const path of projectPaths) {
      await page.request
        .post("/api/projects", { data: { action: "untrack", path } })
        .catch(() => {});
    }
    for (const sessionId of fixture.sessionIds) rmSync(sessionFile(sessionId), { force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("long transcript initial tail, load earlier, and retained append", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const cwd = mkdtempSync(join(tmpdir(), "pican-perf-transcript-"));
  const fixture = generateTranscriptFixture({
    sessionsDir,
    cwd,
    messageCount: 1_600,
  });
  const route = `/session?id=${encodeURIComponent(fixture.sessionId)}`;
  try {
    const preparation = await prepareTemperature(page, route, async () => {
      await expect(
        page.locator('#messages [id^="entry-"]').first(),
      ).toBeAttached();
      await expect(page.locator("#load-earlier-banner")).toBeVisible();
    });
    const temperatureSetup = beginMeasuredTemperatureBoundary(preparation);

    const initialMeasured = await measureTaskBoundary(
      page,
      "session-initial-tail",
      async () => {
        const startedAt = performance.now();
        await page.goto(route);
        await expect(
          page.locator('#messages [id^="entry-"]').first(),
        ).toBeAttached();
        await expect(page.locator("#load-earlier-banner")).toBeVisible();
        return { initialTailMs: performance.now() - startedAt };
      },
    );
    const retainedBaseline = await collectRetainedState(page);

    const loadEarlierMeasured = await measureTaskBoundary(
      page,
      "load-earlier",
      async () => {
        const button = page.locator("#load-earlier-banner button");
        const startedAt = performance.now();
        await button.click();
        await expect(button).toBeEnabled({ timeout: 30_000 });
        return { loadEarlierMs: performance.now() - startedAt };
      },
    );

    const appendCount = 100;
    const appendMarker = `RETAINED-APPEND-${Date.now()}`;
    const appendMeasured = await measureTaskBoundary(
      page,
      "append-100",
      async () => {
        const startedAt = performance.now();
        let parentId = fixture.lastEntryId;
        for (let index = 0; index < appendCount; index += 1) {
          const id = `perf-retained-${Date.now()}-${index}`;
          appendEntry(sessionsDir, fixture.sessionId, {
            type: "message",
            id,
            parentId,
            timestamp: new Date().toISOString(),
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text:
                    index === appendCount - 1
                      ? appendMarker
                      : `Retained append ${index}`,
                },
              ],
              timestamp: Date.now(),
            },
          });
          parentId = id;
        }
        await expect(page.locator("#messages")).toContainText(appendMarker, {
          timeout: 30_000,
        });
        return { append100Ms: performance.now() - startedAt, appendCount };
      },
    );
    const retainedAfterAppend = await collectRetainedState(page);

    expect(
      initialMeasured.metrics.browser.after.visibleTranscriptEntries,
    ).toBeGreaterThan(900);
    expect(
      loadEarlierMeasured.metrics.browser.after.visibleTranscriptEntries,
    ).toBeGreaterThan(
      initialMeasured.metrics.browser.after.visibleTranscriptEntries,
    );
    const boundaries = [
      initialMeasured.metrics,
      loadEarlierMeasured.metrics,
      appendMeasured.metrics,
    ];
    const retained = [retainedBaseline, retainedAfterAppend];
    const resultPath = await writePerfArtifact(testInfo, {
      scenario: "long-transcript",
      temperatureSetup,
      capabilityEvidence: artifactCapabilityEvidence(boundaries, retained),
      fixture,
      task: {
        ...initialMeasured.value,
        ...loadEarlierMeasured.value,
        ...appendMeasured.value,
      },
      boundaries: {
        initialTail: initialMeasured.metrics,
        loadEarlier: loadEarlierMeasured.metrics,
        append100: appendMeasured.metrics,
      },
      retained: {
        baselineAfterForcedGc: retainedBaseline,
        afterAppendForcedGc: retainedAfterAppend,
        appendDelta: retainedStateDelta(retainedBaseline, retainedAfterAppend),
      },
    });
    console.log(
      `[perf] long transcript: initial ${initialMeasured.value.initialTailMs.toFixed(1)}ms, earlier ${loadEarlierMeasured.value.loadEarlierMs.toFixed(1)}ms, append ${appendMeasured.value.append100Ms.toFixed(1)}ms -> ${resultPath}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("offline session catches up exactly once", async ({
  page,
  context,
  sessionsDir,
}, testInfo) => {
  const cwd = mkdtempSync(join(tmpdir(), "pican-perf-reconnect-"));
  const fixture = generateTranscriptFixture({
    sessionsDir,
    cwd,
    messageCount: 20,
  });
  const marker = `RECOVERED-${Date.now()}`;
  const route = `/session?id=${encodeURIComponent(fixture.sessionId)}`;
  try {
    const preparation = await prepareTemperature(page, route, async () => {
      await expect(
        page.locator('#messages [id^="entry-"]').first(),
      ).toBeAttached();
    });
    const temperatureSetup = beginMeasuredTemperatureBoundary(preparation);
    await page.goto(route);
    await expect(
      page.locator('#messages [id^="entry-"]').first(),
    ).toBeAttached();
    await context.setOffline(true);
    appendEntry(sessionsDir, fixture.sessionId, {
      type: "message",
      id: `perf-recovery-${Date.now()}`,
      parentId: fixture.lastEntryId,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: marker }],
        timestamp: Date.now(),
      },
    });
    await page.waitForTimeout(500);
    const measured = await measureTaskBoundary(
      page,
      "offline-authoritative-catch-up",
      async () => {
        const startedAt = performance.now();
        await context.setOffline(false);
        await expect(page.locator("#messages")).toContainText(marker, {
          timeout: 15_000,
        });
        return { recoveryMs: performance.now() - startedAt };
      },
    );
    const markerCount = await page.getByText(marker, { exact: true }).count();
    expect(markerCount).toBe(1);
    const retained = await collectRetainedState(page);
    const boundaries = [measured.metrics];
    const resultPath = await writePerfArtifact(testInfo, {
      scenario: "offline-recovery",
      temperatureSetup,
      capabilityEvidence: artifactCapabilityEvidence(boundaries, [retained]),
      fixture,
      task: {
        offlineMs: 500,
        recoveryMs: measured.value.recoveryMs,
        markerCount,
      },
      boundaries: { authoritativeCatchUp: measured.metrics },
      retained: { afterCatchUp: retained },
    });
    console.log(
      `[perf] offline recovery: ${measured.value.recoveryMs.toFixed(1)}ms -> ${resultPath}`,
    );
  } finally {
    await context.setOffline(false);
    rmSync(cwd, { recursive: true, force: true });
  }
});
