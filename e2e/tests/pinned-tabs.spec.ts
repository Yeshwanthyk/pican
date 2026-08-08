import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../lib/test";
import {
  assistantTextEntry,
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";

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
    const cwd = realWorkingDir();
    const alpha = buildSession({ cwd });
    const beta = buildSession({ cwd });
    const alphaEntries = [...alpha.entries];
    let alphaParentId = alpha.lastId;
    for (let index = 0; index < 24; index += 1) {
      const next = assistantTextEntry(
        alphaParentId,
        `Transcript row ${index + 1}\n\n${"Long pinned-session scroll context. ".repeat(12)}`,
      );
      alphaEntries.push(next.entry);
      alphaParentId = next.id;
    }
    writeSession(sessionsDir, alphaId, [
      ...alphaEntries,
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
      await expect(page.locator(".session-header-project")).toHaveAttribute("title", cwd);
      await expect(page.locator("#pinned-session-switcher")).toHaveCount(0);
      await expect(page.locator("#session-header-title")).not.toHaveAttribute("popovertarget");
      await expect(page.locator(".pinned-tab--guest")).toContainText("Tabs Alpha");
      await page.locator(".pinned-tab--guest .pinned-tab-pin").click();
      await expect(page.locator(".pinned-tab--guest")).toHaveCount(0);

      await page.goto(`/session?id=${encodeURIComponent(betaId)}`);
      await expect(page.locator(`[data-session-id="${alphaId}"]`)).toBeVisible();
      await expect(page.locator(".pinned-tab--guest")).toContainText("Tabs Beta");
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
        const markedWindow = window as Window & {
          __picanPinnedSwitchDocument?: string;
        };
        markedWindow.__picanPinnedSwitchDocument = identity;
        return {
          identity,
          navigationCount: performance.getEntriesByType("navigation").length,
        };
      });

      const alphaTab = page.locator(`[data-session-id="${alphaId}"] > a`);
      const prefetched = page.waitForResponse((response) => isTargetSessionRequest(response.url()));
      await alphaTab.hover();
      await prefetched;
      await alphaTab.click();
      await expect(page).toHaveURL(new RegExp(`id=${encodeURIComponent(alphaId)}`));
      await expect(page.locator('.pinned-tabs-strip [aria-current="page"]')).toContainText(
        "Tabs Alpha",
      );
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

      const exactAlphaDraft = "  alpha draft\nline two with trailing space  ";
      await page.locator("#pi-chat-message").evaluate((element, draft) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.value = draft;
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      }, exactAlphaDraft);
      const alphaScrollTop = await page.locator("#content").evaluate((element) => {
        const content = element as HTMLElement;
        const maximum = content.scrollHeight - content.clientHeight;
        if (maximum <= 0) throw new Error("alpha transcript must be scrollable");
        content.scrollTop = Math.max(1, Math.floor(maximum * 0.35));
        content.dispatchEvent(new Event("scroll"));
        return content.scrollTop;
      });
      expect(alphaScrollTop).toBeGreaterThan(0);
      await expect(page.locator(".follow-button")).toBeVisible();

      const betaSessionRequests: string[] = [];
      const betaSessionStreams: string[] = [];
      const trackBetaRequests = (request: import("@playwright/test").Request) => {
        const url = new URL(request.url());
        if (
          url.pathname === "/api/session" &&
          url.searchParams.get("id") === betaId &&
          url.searchParams.get("paginate") === "1"
        ) {
          betaSessionRequests.push(request.url());
        }
        if (url.pathname === "/events" && url.searchParams.get("id") === betaId) {
          betaSessionStreams.push(request.url());
        }
      };
      page.on("request", trackBetaRequests);
      const betaTab = page.locator(`[data-session-id="${betaId}"] > a`);
      const betaPrefetched = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/session" &&
          url.searchParams.get("id") === betaId &&
          url.searchParams.get("paginate") === "1"
        );
      });
      await betaTab.hover();
      await betaPrefetched;
      await betaTab.click();
      await expect(page).toHaveURL(new RegExp(`id=${encodeURIComponent(betaId)}`));
      await expect.poll(() => betaSessionStreams.length).toBe(1);
      expect(betaSessionRequests).toHaveLength(1);
      page.off("request", trackBetaRequests);

      const restoredAlphaRequests: string[] = [];
      const restoredAlphaStreams: string[] = [];
      const trackRestoredAlpha = (request: import("@playwright/test").Request) => {
        if (isTargetSessionRequest(request.url())) restoredAlphaRequests.push(request.url());
        if (isTargetSessionStream(request.url())) restoredAlphaStreams.push(request.url());
      };
      page.on("request", trackRestoredAlpha);
      const restoredAlphaPrefetch = page.waitForResponse((response) =>
        isTargetSessionRequest(response.url()),
      );
      await alphaTab.hover();
      await restoredAlphaPrefetch;
      await alphaTab.click();
      await expect(page).toHaveURL(new RegExp(`id=${encodeURIComponent(alphaId)}`));
      await expect(page.locator("#pi-chat-message")).toHaveValue(exactAlphaDraft);
      await expect
        .poll(() => page.locator("#content").evaluate((element) => element.scrollTop))
        .toBe(alphaScrollTop);
      await expect(page.locator(".follow-button")).toBeVisible();
      await expect.poll(() => restoredAlphaStreams.length).toBe(1);
      expect(restoredAlphaRequests).toHaveLength(1);
      expect(restoredAlphaStreams).toHaveLength(1);
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
      page.off("request", trackRestoredAlpha);

      await page.locator("#command-menu-btn").click();
      await page
        .locator('#command-menu-popover [data-action="archive"]')
        .filter({ hasText: "Archive this session" })
        .click();
      await expect(page).toHaveURL(/\/$/);

      await page.goto(`/session?id=${encodeURIComponent(alphaId)}`);
      await expect(page.locator(".pinned-tab--guest")).toContainText("Tabs Alpha");
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
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  test("Pixel touch prefetch keeps ten pins on one document with bounded SSE", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "Mobile Chrome", "Pixel 5 acceptance proof");

    await page.addInitScript(() => {
      localStorage.setItem("pican:v1:session-tabs", "true");
      localStorage.setItem("pican:v1:right-sidebar-collapsed", "true");
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

    const projects = Array.from({ length: 5 }, () => realWorkingDir());
    const sessionIds = Array.from({ length: 10 }, (_, index) => {
      const id = uniqueSessionName(testInfo, `pixel-pin-${index}`);
      const session = buildSession({ cwd: projects[index % projects.length] });
      writeSession(sessionsDir, id, [
        ...session.entries,
        {
          type: "session_info",
          timestamp: new Date().toISOString(),
          name: `Pixel Pin ${index + 1}`,
        },
      ]);
      const path = join(sessionsDir, "--home-user-demo-project--", id);
      const settledMtime = new Date(Date.now() - 5_000);
      utimesSync(path, settledMtime, settledMtime);
      return id;
    });
    const sessionPath = (id: string) => join(sessionsDir, "--home-user-demo-project--", id);
    const curate = (sessionId: string, pinned: boolean) =>
      page.request.post("/api/pins", { data: { sessionId, pinned } });
    const isSessionRequest = (rawURL: string, id: string) => {
      const url = new URL(rawURL);
      return (
        url.pathname === "/api/session" &&
        url.searchParams.get("id") === id &&
        url.searchParams.get("paginate") === "1"
      );
    };
    type RawMetrics = {
      process: {
        sse_clients: number;
        sse_global_streams: number;
        sse_session_streams: number;
      };
    };
    const readSse = async () => {
      const response = await page.request.get("/api/metrics");
      expect(response.ok()).toBeTruthy();
      return ((await response.json()) as RawMetrics).process;
    };

    try {
      for (const sessionId of sessionIds) {
        const sessionResponse = await page.request.get(
          `/api/session?id=${encodeURIComponent(sessionId)}&paginate=1`,
        );
        expect(sessionResponse.ok(), await sessionResponse.text()).toBeTruthy();
        const response = await curate(sessionId, true);
        expect(response.ok(), await response.text()).toBeTruthy();
      }

      await page.goto(`/session?id=${encodeURIComponent(sessionIds[0])}`);
      await expect(page.locator('#messages [id^="entry-"]').first()).toBeAttached();
      await expect(page.locator(".pinned-chips")).toBeVisible();
      await expect
        .poll(async () => {
          const response = await page.request.get("/api/pins");
          if (!response.ok()) return 0;
          const catalog = (await response.json()) as { pins: string[] };
          return catalog.pins.filter((id) => sessionIds.includes(id)).length;
        })
        .toBe(10);

      const exactDraft = "  Pixel draft\nkeeps whitespace  ";
      await page.locator("#pi-chat-message").evaluate((element, draft) => {
        const textarea = element as HTMLTextAreaElement;
        textarea.value = draft;
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      }, exactDraft);
      const documentIdentity = await page.evaluate(() => {
        const identity = crypto.randomUUID();
        const markedWindow = window as Window & {
          __pixelPinnedDocument?: string;
        };
        markedWindow.__pixelPinnedDocument = identity;
        return {
          identity,
          navigationCount: performance.getEntriesByType("navigation").length,
        };
      });
      const currentDocumentIdentity = () =>
        page.evaluate(() => {
          const markedWindow = window as Window & {
            __pixelPinnedDocument?: string;
          };
          return {
            identity: markedWindow.__pixelPinnedDocument,
            navigationCount: performance.getEntriesByType("navigation").length,
          };
        });

      for (const targetId of [sessionIds[1], sessionIds[0]]) {
        const requests: string[] = [];
        const trackRequest = (request: import("@playwright/test").Request) => {
          if (isSessionRequest(request.url(), targetId)) requests.push(request.url());
        };
        page.on("request", trackRequest);
        const target = page.locator(`.pinned-chip[data-session-id="${targetId}"] > a`);
        await expect(target).toBeVisible();
        const prefetched = page.waitForResponse((response) =>
          isSessionRequest(response.url(), targetId),
        );
        await target.dispatchEvent("touchstart");
        await prefetched;
        await target.click();
        await expect(page).toHaveURL(new RegExp(`id=${encodeURIComponent(targetId)}`));
        await expect(page.locator('#messages [id^="entry-"]').first()).toBeAttached();
        expect(requests).toHaveLength(1);
        page.off("request", trackRequest);
        await expect.poll(async () => (await readSse()).sse_session_streams).toBe(1);
        const ownership = await readSse();
        expect(ownership.sse_clients).toBe(
          ownership.sse_global_streams + ownership.sse_session_streams,
        );
        expect(await currentDocumentIdentity()).toEqual(documentIdentity);
      }
      await expect(page.locator("#pi-chat-message")).toHaveValue(exactDraft);
    } finally {
      for (const sessionId of sessionIds) {
        await curate(sessionId, false).catch(() => {});
        rmSync(sessionPath(sessionId), { force: true });
      }
      for (const project of projects) rmSync(project, { recursive: true, force: true });
    }
  });
});
