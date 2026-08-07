import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import { buildSession, uniqueSessionName, writeSession } from "../lib/sessions";

test.describe("pinned session tabs", () => {
  test("pins, switches, restores archived sessions, and keeps curation in sync", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "Desktop Chrome",
      "the session curation flow is browser-independent; run once",
    );

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

    const alphaId = uniqueSessionName(testInfo, "tabs-alpha");
    const betaId = uniqueSessionName(testInfo, "tabs-beta");
    const alpha = buildSession();
    const beta = buildSession();
    writeSession(sessionsDir, alphaId, [
      ...alpha.entries,
      {
        type: "session_info",
        timestamp: new Date().toISOString(),
        name: "Tabs Alpha",
      },
    ]);
    writeSession(sessionsDir, betaId, [
      ...beta.entries,
      {
        type: "session_info",
        timestamp: new Date().toISOString(),
        name: "Tabs Beta",
      },
    ]);

    const alphaPath = join(sessionsDir, "--home-user-demo-project--", alphaId);
    const betaPath = join(sessionsDir, "--home-user-demo-project--", betaId);
    const settledMtime = new Date(Date.now() - 5_000);
    utimesSync(alphaPath, settledMtime, settledMtime);
    utimesSync(betaPath, settledMtime, settledMtime);
    const curate = (path: "/api/pins" | "/api/archives", body: object) =>
      page.request.post(path, { data: body });

    try {
      await page.goto(`/session?id=${encodeURIComponent(alphaId)}`);
      await expect(page.locator(".pinned-tabs-strip")).toBeVisible();
      await expect(page.locator(".session-header-project")).toHaveText(
        "~/live-demo",
      );
      await expect(page.locator("#pinned-session-switcher")).toHaveCount(0);
      await expect(page.locator("#session-header-title")).not.toHaveAttribute(
        "popovertarget",
      );
      await expect(page.locator(".pinned-tab--guest")).toContainText(
        "Tabs Alpha",
      );
      await page.locator(".pinned-tab--guest .pinned-tab-pin").click();
      await expect(page.locator(".pinned-tab--guest")).toHaveCount(0);

      await page.goto(`/session?id=${encodeURIComponent(betaId)}`);
      await expect(
        page.locator(`[data-session-id="${alphaId}"]`),
      ).toBeVisible();
      await expect(page.locator(".pinned-tab--guest")).toContainText(
        "Tabs Beta",
      );
      await page.locator(".pinned-tab--guest .pinned-tab-pin").click();
      await expect(page.locator(".pinned-tab")).toHaveCount(2);

      const targetSessionRequests: string[] = [];
      const targetSessionStreams: string[] = [];
      const isTargetSessionRequest = (rawURL: string) => {
        const url = new URL(rawURL);
        return (
          url.pathname === "/api/session" &&
          url.searchParams.get("id") === alphaId &&
          url.searchParams.get("paginate") === "1"
        );
      };
      const isTargetSessionStream = (rawURL: string) => {
        const url = new URL(rawURL);
        return url.pathname === "/events" && url.searchParams.get("id") === alphaId;
      };
      const trackTargetRequests = (request: import("@playwright/test").Request) => {
        if (isTargetSessionRequest(request.url())) targetSessionRequests.push(request.url());
        if (isTargetSessionStream(request.url())) targetSessionStreams.push(request.url());
      };
      page.on("request", trackTargetRequests);
      const documentIdentity = await page.evaluate(() => {
        const identity = crypto.randomUUID();
        const markedWindow = window as Window & { __picanPinnedSwitchDocument?: string };
        markedWindow.__picanPinnedSwitchDocument = identity;
        return {
          identity,
          navigationCount: performance.getEntriesByType("navigation").length,
        };
      });

      const alphaTab = page.locator(`[data-session-id="${alphaId}"] > a`);
      const prefetched = page.waitForResponse((response) =>
        isTargetSessionRequest(response.url()),
      );
      await alphaTab.hover();
      await prefetched;
      await alphaTab.click();
      await expect(page).toHaveURL(
        new RegExp(`id=${encodeURIComponent(alphaId)}`),
      );
      await expect(
        page.locator('.pinned-tabs-strip [aria-current="page"]'),
      ).toContainText("Tabs Alpha");
      await expect.poll(() => targetSessionStreams.length).toBe(1);

      expect(targetSessionRequests).toHaveLength(1);
      expect(targetSessionStreams).toHaveLength(1);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const markedWindow = window as Window & {
              __picanPinnedSwitchDocument?: string;
            };
            return {
              identity: markedWindow.__picanPinnedSwitchDocument,
              navigationCount: performance.getEntriesByType("navigation").length,
            };
          }),
        )
        .toEqual(documentIdentity);
      page.off("request", trackTargetRequests);

      await page.locator("#command-menu-btn").click();
      await page
        .locator('#command-menu-popover [data-action="archive"]')
        .filter({ hasText: "Archive this session" })
        .click();
      await expect(page).toHaveURL(/\/$/);

      await page.goto(`/session?id=${encodeURIComponent(alphaId)}`);
      await expect(page.locator(".pinned-tab--guest")).toContainText(
        "Tabs Alpha",
      );
      await page.locator(".pinned-tab--guest .pinned-tab-pin").click();
      await page.locator("#command-menu-btn").click();
      await expect(
        page
          .locator('#command-menu-popover [data-action="archive"]')
          .filter({ hasText: "Archive this session" }),
      ).toBeVisible();
      await page
        .locator('#command-menu-popover [data-action="archive"]')
        .filter({ hasText: "Archive this session" })
        .click();
      await expect(page).toHaveURL(/\/$/);

      await page.goto(`/session?id=${encodeURIComponent(alphaId)}`);
      await page.locator("#command-menu-btn").click();
      await page
        .locator('#command-menu-popover [data-action="archive"]')
        .filter({ hasText: "Restore this session" })
        .click();
      await page.locator("#command-menu-btn").click();
      await expect(
        page
          .locator('#command-menu-popover [data-action="archive"]')
          .filter({ hasText: "Archive this session" }),
      ).toBeVisible();
    } finally {
      await curate("/api/pins", { sessionId: alphaId, pinned: false });
      await curate("/api/pins", { sessionId: betaId, pinned: false });
      await curate("/api/archives", { sessionId: alphaId, archived: false });
      await curate("/api/archives", { sessionId: betaId, archived: false });
      rmSync(alphaPath, { force: true });
      rmSync(betaPath, { force: true });
    }
  });
});
