import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { generateTranscriptFixture } from "../perf/fixtures";
import { collapseRightSidebar, expect, test } from "../lib/test";

async function waitForEarlierWindow(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const banner = document.querySelector("#load-earlier-banner");
      const button = banner?.querySelector("button");
      return !banner || (button instanceof HTMLButtonElement && !button.disabled);
    },
    { timeout: 30_000 },
  );
}

async function transcriptIds(page: Page): Promise<{
  canonical: string[];
  rendered: string[];
}> {
  return page.locator("#messages-list > .transcript-render-item").evaluateAll((items) => {
    const canonical: string[] = [];
    const rendered: string[] = [];
    for (const item of items) {
      const anchor = item.firstElementChild?.id?.replace(/^entry-/, "") ?? "";
      if (anchor) rendered.push(anchor);
      if (item.getAttribute("data-render-kind") === "group") {
        const encoded = item.firstElementChild?.getAttribute("data-activity-target-ids") ?? "";
        canonical.push(...new URLSearchParams(encoded).getAll("id"));
      } else if (anchor) {
        canonical.push(anchor);
      }
    }
    return { canonical, rendered };
  });
}

test("5k transcript preserves browser transcript contracts", async ({
  context,
  page,
  sessionsDir,
}, testInfo) => {
  test.skip(
    testInfo.project.name.startsWith("Mobile") || testInfo.project.name.startsWith("iPad"),
    "one desktop project per engine bounds this 5k cross-engine proof",
  );
  test.setTimeout(120_000);

  const cwd = mkdtempSync(join(tmpdir(), "pican-e2e-containment-"));
  const fixture = generateTranscriptFixture({
    sessionsDir,
    cwd,
    messageCount: 5_000,
    profile: "light",
  });
  const route = `/session?id=${encodeURIComponent(fixture.sessionId)}`;

  try {
    await page.waitForTimeout(100);
    await collapseRightSidebar(page);
    const eventStream = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/events" && url.searchParams.get("id") === fixture.sessionId;
    });
    await page.goto(route);
    await eventStream;
    const list = page.locator("#messages-list");
    const banner = page.locator("#load-earlier-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });

    let maxAnchorDrift = 0;
    let windowsLoaded = 0;
    while ((await banner.count()) > 0 && windowsLoaded < 2) {
      await banner.scrollIntoViewIfNeeded();
      const anchor = page
        .locator("#messages-list > .transcript-render-item > .user-message")
        .first();
      const anchorId = await anchor.getAttribute("id");
      expect(anchorId).toBeTruthy();
      const anchorTop = await anchor.evaluate((element) => element.getBoundingClientRect().top);
      const before = await page.locator(".transcript-render-item").count();

      await banner.getByRole("button").click();
      await waitForEarlierWindow(page);
      await expect
        .poll(() => page.locator(".transcript-render-item").count(), {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(before);
      if (windowsLoaded === 0) {
        // Force the inserted range's layout, then verify the production anchor
        // correction after its bounded settling frames.
        await page
          .locator(`#${anchorId}`)
          .evaluate((element) => element.getBoundingClientRect().top);
        await page.waitForTimeout(100);
        await expect
          .poll(
            () =>
              page
                .locator(`#${anchorId}`)
                .evaluate(
                  (element, top) => Math.abs(element.getBoundingClientRect().top - top),
                  anchorTop,
                ),
            { timeout: 30_000 },
          )
          .toBeLessThanOrEqual(2);
        maxAnchorDrift = await page
          .locator(`#${anchorId}`)
          .evaluate(
            (element, top) => Math.abs(element.getBoundingClientRect().top - top),
            anchorTop,
          );
      }
      windowsLoaded += 1;
    }

    await expect(banner).toBeVisible();
    expect(windowsLoaded).toBe(2);
    expect(maxAnchorDrift).toBeLessThanOrEqual(2);
    const activeIdentity = await transcriptIds(page);
    expect(activeIdentity.canonical).toEqual(
      fixture.entryIds.slice(fixture.entryIds.length - activeIdentity.canonical.length),
    );
    expect(activeIdentity.rendered).toEqual(activeIdentity.canonical);
    expect(new Set(activeIdentity.canonical).size).toBe(activeIdentity.canonical.length);

    const content = page.locator("#content");
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const findIndex = fixture.entryIds.length - activeIdentity.canonical.length + 10;
    const findText = `Transcript message ${findIndex}: deterministic performance fixture content.`;
    const findId = fixture.entryIds[findIndex];
    expect(findId).toBeTruthy();
    const foundByTextWalker = await page.evaluate((text) => {
      const root = document.getElementById("messages-list");
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.includes(text)) continue;
        return node.parentElement?.closest<HTMLElement>('[id^="entry-"]')?.id ?? null;
      }
      return null;
    }, findText);
    expect(foundByTextWalker).toBe(`entry-${findId}`);

    await page.locator(`#entry-${findId}`).scrollIntoViewIfNeeded();
    const selectedText = await page
      .locator(`#entry-${findId} .markdown-content`)
      .evaluate((element) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return selection?.toString() ?? "";
      });
    if (testInfo.project.name !== "Desktop Firefox") {
      expect(selectedText).toContain(findText);
    }

    const focusButton = page.locator(`#entry-${findId} .copy-link-btn`);
    await focusButton.focus();
    await expect(focusButton).toBeFocused();
    expect(
      await focusButton.evaluate((button) => !button.closest('[aria-hidden="true"], [inert]')),
    ).toBe(true);
    const aria = await page.locator(`#entry-${findId}`).ariaSnapshot();
    expect(aria.indexOf('button "Copy message"')).toBeGreaterThanOrEqual(0);
    expect(aria.indexOf('button "Copy link to this message"')).toBeGreaterThan(
      aria.indexOf('button "Copy message"'),
    );

    const deepTargetId = fixture.entryIds.at(-25);
    expect(deepTargetId).toBeTruthy();
    const deepPage = await context.newPage();
    try {
      await deepPage.goto(
        `${route}&leafId=${encodeURIComponent(fixture.lastEntryId)}&targetId=${encodeURIComponent(deepTargetId ?? "")}`,
      );
      const deepTarget = deepPage.locator(`#entry-${deepTargetId}`);
      await expect(deepTarget).toBeAttached({ timeout: 30_000 });
      await expect(deepTarget).toHaveClass(/highlight/);
      await expect
        .poll(() =>
          deepTarget.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
          }),
        )
        .toBe(true);
    } finally {
      await deepPage.close();
    }
  } finally {
    await context.setOffline(false);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("20k activity transcript preserves its bounded projection", async ({
  page,
  sessionsDir,
}, testInfo) => {
  test.skip(testInfo.project.name !== "Desktop Chrome", "one Chromium 20k acceptance proof");
  test.setTimeout(120_000);
  const cwd = mkdtempSync(join(tmpdir(), "pican-e2e-20k-"));
  const fixture = generateTranscriptFixture({
    sessionsDir,
    cwd,
    messageCount: 20_000,
    profile: "activity-tool",
  });
  const route = `/session?id=${encodeURIComponent(fixture.sessionId)}`;

  try {
    const stream = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/events" && url.searchParams.get("id") === fixture.sessionId;
    });
    await page.goto(route);
    await stream;
    await expect(page.locator("#load-earlier-banner")).toBeVisible({ timeout: 30_000 });
    const beforeIdentity = await transcriptIds(page);
    const beforeStart = fixture.entryIds.indexOf(beforeIdentity.canonical[0] ?? "");
    expect(beforeStart).toBeGreaterThanOrEqual(0);
    expect(beforeIdentity.canonical).toEqual(fixture.entryIds.slice(beforeStart));

    const anchor = page.locator("#messages-list > .transcript-render-item > .user-message").first();
    const anchorId = await anchor.getAttribute("id");
    expect(anchorId).toBeTruthy();
    const anchorTop = await anchor.evaluate((element) => element.getBoundingClientRect().top);
    await page.locator("#load-earlier-banner button").click();
    await waitForEarlierWindow(page);
    await page.locator(`#${anchorId}`).evaluate((element) => element.getBoundingClientRect().top);
    await page.waitForTimeout(250);
    const anchorDriftPx = await page.locator(`#${anchorId}`).evaluate(
      (element, top) => Math.abs(element.getBoundingClientRect().top - top),
      anchorTop,
    );
    expect(Number.isFinite(anchorDriftPx)).toBe(true);
    await testInfo.attach("20k-load-earlier-anchor.json", {
      body: Buffer.from(JSON.stringify({ anchorDriftPx }, null, 2)),
      contentType: "application/json",
    });

    const afterIdentity = await transcriptIds(page);
    const afterStart = fixture.entryIds.indexOf(afterIdentity.canonical[0] ?? "");
    expect(afterStart).toBeGreaterThanOrEqual(0);
    const expectedCanonical = fixture.entryIds.slice(afterStart);
    const expectedSet = new Set(expectedCanonical);
    expect(afterIdentity.canonical).toEqual(expectedCanonical);
    expect(afterIdentity.rendered).toEqual(
      fixture.renderItemIds.filter((id) => expectedSet.has(id)),
    );
    expect(new Set(afterIdentity.canonical).size).toBe(afterIdentity.canonical.length);

    const fold = page.locator("details.activity-fold").first();
    const deepTargetId = await fold.evaluate((element) =>
      new URLSearchParams(element.dataset.activityTargetIds ?? "").getAll("id").at(-1),
    );
    expect(deepTargetId).toBeTruthy();
    await fold.locator("summary").click();
    const deepTarget = page.locator(`#entry-${deepTargetId}`);
    await expect(deepTarget).toBeAttached();
    await deepTarget.scrollIntoViewIfNeeded();
    await expect(deepTarget).toBeInViewport();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
