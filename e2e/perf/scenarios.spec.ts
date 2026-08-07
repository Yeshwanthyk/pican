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

test("bounded project home load", async ({ page, sessionsDir }, testInfo) => {
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
    for (const sessionId of fixture.sessionIds.slice(0, 10)) {
      const response = await page.request.post("/api/pins", {
        data: { sessionId, pinned: true },
      });
      expect(response.ok()).toBeTruthy();
    }

    const preparation = await prepareTemperature(page, "/", async () => {
      await expect(page.locator(".activity-row").first()).toBeVisible();
    });
    const temperatureSetup = beginMeasuredTemperatureBoundary(preparation);
    const measured = await measureTaskBoundary(page, "home-initial-load", async () => {
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
      const projectCount = await page
        .locator('.activity-group--project[data-project]')
        .count();
      expect(projectCount).toBe(5);
      expect(rowCount).toBeLessThanOrEqual(40);
      return { firstRowMs, rowCount, projectCount };
    });
    const retained = await collectRetainedState(page);
    const boundaries = [measured.metrics];
    const resultPath = await writePerfArtifact(testInfo, {
      scenario: "bounded-project-home",
      temperatureSetup,
      capabilityEvidence: artifactCapabilityEvidence(boundaries, [retained]),
      fixture: {
        projects: projectPaths.length,
        sessions: fixture.sessionIds.length,
        pins: 10,
        serializedBytes: fixture.serializedBytes,
      },
      task: measured.value,
      boundaries: { initialLoad: measured.metrics },
      retained: { afterInitialLoad: retained },
    });
    console.log(
      `[perf] bounded project home: ${measured.value.firstRowMs.toFixed(1)}ms -> ${resultPath}`,
    );
  } finally {
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
