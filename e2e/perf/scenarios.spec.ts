import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import { appendEntry } from "../lib/sessions";
import { generateCatalogFixture, generateTranscriptFixture } from "./fixtures";
import {
  applyOptionalThrottle,
  collectChromiumMemory,
  collectSnapshot,
  installPerformanceObservers,
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

    const snapshot = await collectSnapshot(page);
    const chromiumMemory = await collectChromiumMemory(page);
    const resultPath = await writePerfArtifact(testInfo, {
      scenario: "bounded-project-home",
      fixture: {
        projects: projectPaths.length,
        sessions: fixture.sessionIds.length,
        pins: 10,
        serializedBytes: fixture.serializedBytes,
      },
      task: { firstRowMs, rowCount, projectCount },
      browser: snapshot,
      chromiumMemory,
    });
    console.log(
      `[perf] bounded project home: ${firstRowMs.toFixed(1)}ms -> ${resultPath}`,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("long transcript initial tail and load earlier", async ({
  page,
  sessionsDir,
}, testInfo) => {
  const cwd = mkdtempSync(join(tmpdir(), "pican-perf-transcript-"));
  const fixture = generateTranscriptFixture({
    sessionsDir,
    cwd,
    messageCount: 1_600,
  });
  try {
    const startedAt = performance.now();
    await page.goto(`/session?id=${encodeURIComponent(fixture.sessionId)}`);
    await expect(
      page.locator('#messages [id^="entry-"]').first(),
    ).toBeAttached();
    await expect(page.locator("#load-earlier-banner")).toBeVisible();
    const initialTailMs = performance.now() - startedAt;
    const initial = await collectSnapshot(page);

    const button = page.locator("#load-earlier-banner button");
    const loadEarlierStartedAt = performance.now();
    await button.click();
    await expect(button).toBeEnabled({ timeout: 30_000 });
    const loadEarlierMs = performance.now() - loadEarlierStartedAt;
    const afterLoadEarlier = await collectSnapshot(page);
    const chromiumMemory = await collectChromiumMemory(page);

    expect(initial.visibleTranscriptEntries).toBeGreaterThan(900);
    expect(afterLoadEarlier.visibleTranscriptEntries).toBeGreaterThan(
      initial.visibleTranscriptEntries,
    );
    const resultPath = await writePerfArtifact(testInfo, {
      scenario: "long-transcript",
      fixture,
      task: { initialTailMs, loadEarlierMs },
      initial,
      afterLoadEarlier,
      chromiumMemory,
    });
    console.log(
      `[perf] long transcript: initial ${initialTailMs.toFixed(1)}ms, earlier ${loadEarlierMs.toFixed(1)}ms -> ${resultPath}`,
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
  try {
    await page.goto(`/session?id=${encodeURIComponent(fixture.sessionId)}`);
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
    const recoveryStartedAt = performance.now();
    await context.setOffline(false);
    await expect(page.locator("#messages")).toContainText(marker, {
      timeout: 15_000,
    });
    const recoveryMs = performance.now() - recoveryStartedAt;
    const markerCount = await page.getByText(marker, { exact: true }).count();
    expect(markerCount).toBe(1);
    const snapshot = await collectSnapshot(page);
    const resultPath = await writePerfArtifact(testInfo, {
      scenario: "offline-recovery",
      fixture,
      task: { offlineMs: 500, recoveryMs, markerCount },
      browser: snapshot,
    });
    console.log(
      `[perf] offline recovery: ${recoveryMs.toFixed(1)}ms -> ${resultPath}`,
    );
  } finally {
    await context.setOffline(false);
    rmSync(cwd, { recursive: true, force: true });
  }
});
