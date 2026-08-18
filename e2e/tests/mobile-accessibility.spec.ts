import { rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import {
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";
import {
  collapseRightSidebar,
  expect,
  test,
  waitForSessionReady,
} from "../lib/test";

const TARGET_SIZE = 44;

function skipUnlessMobile(page: Page): void {
  test.skip(
    (page.viewportSize()?.width ?? Number.POSITIVE_INFINITY) > 900,
    "V6 phone assertions exercise the <=900px layout",
  );
}

async function waitForHome(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator("[data-sessions-content].index-layout-ready").waitFor();
}

interface MobileSessionFixture {
  readonly name: string;
  cleanup(): Promise<void>;
}

async function seedMobileSession(
  page: Page,
  sessionsDir: string,
  testInfo: TestInfo,
): Promise<MobileSessionFixture> {
  const cwd = realWorkingDir();
  const name = `Mobile accessibility ${testInfo.workerIndex} ${Date.now()}`;
  const fixture = buildSession({ cwd });
  const entries = fixture.entries.map((entry, index) =>
    index === 0 ? { ...entry, name } : entry,
  );
  const filename = uniqueSessionName(testInfo, "mobile-accessibility");
  writeSession(sessionsDir, filename, entries);
  const response = await page.request.post("/api/projects", {
    data: { action: "track", path: cwd },
  });
  expect(response.ok(), await response.text()).toBeTruthy();

  return {
    name,
    async cleanup() {
      await page.request.post("/api/projects", {
        data: { action: "untrack", path: cwd },
      });
      rmSync(cwd, { recursive: true, force: true });
      try {
        unlinkSync(join(sessionsDir, "--home-user-demo-project--", filename));
      } catch {
        // Global E2E cleanup owns a fixture that the watcher already removed.
      }
    },
  };
}

async function openSeededSession(page: Page, name: string): Promise<void> {
  await page
    .locator(".session-ticker-row", { hasText: name })
    .locator(".session-ticker-link")
    .click();
  await expect(page).toHaveURL(/\/session\?id=/);
  await waitForSessionReady(page);
}

async function expectAtLeast44(locator: Locator, label: string): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} should have a rendered hit box`).not.toBeNull();
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(
    TARGET_SIZE - 0.5,
  );
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(
    TARGET_SIZE - 0.5,
  );
}

async function expectVisibleFocus(locator: Locator): Promise<void> {
  // Establish keyboard modality first, then focus the exact control. WebKit's
  // mobile profile does not Tab through every button unless the host enables
  // full keyboard access, but it still applies :focus-visible after a key move.
  await locator.page().keyboard.press("Tab");
  await locator.focus();
  await expect(locator).toBeFocused();

  const focus = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      boxShadow: style.boxShadow,
    };
  });
  expect(focus.focusVisible).toBe(true);
  expect(focus.outlineStyle).not.toBe("none");
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(focus.boxShadow).not.toBe("none");
}

test.describe("mobile accessibility checkpoint", () => {
  test("keeps primary home and session interactions at least 44px with names", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    skipUnlessMobile(page);
    const fixture = await seedMobileSession(page, sessionsDir, testInfo);
    try {
      await collapseRightSidebar(page);
      await waitForHome(page);

      const row = page.locator(".session-ticker-row", {
        hasText: fixture.name,
      });
      const homeTargets = [
        [page.locator(".mobile-thumb-search"), "Search sessions"],
        [page.locator(".mobile-thumb-new"), "Start a new session"],
        [page.locator(".mobile-thumb-menu"), "Open menu"],
        [row.locator(".activity-row-link"), "Seeded session row"],
        [row.locator(".session-ticker-more"), "Session row actions"],
      ] as const;

      for (const [locator, label] of homeTargets) {
        await expect(locator, `${label} should be visible`).toBeVisible();
        await expect(
          locator,
          `${label} should expose an accessible name`,
        ).toHaveAccessibleName(/\S/);
        await expectAtLeast44(locator, label);
      }

      await openSeededSession(page, fixture.name);
      const sessionTargets = [
        [page.locator(".session-header-back"), "Back to sessions"],
        [page.locator("#command-menu-btn"), "Session actions"],
        [page.locator("#pi-chat-message"), "Message composer"],
      ] as const;

      for (const [locator, label] of sessionTargets) {
        await expect(locator, `${label} should be visible`).toBeVisible();
        await expect(
          locator,
          `${label} should expose an accessible name`,
        ).toHaveAccessibleName(/\S/);
        await expectAtLeast44(locator, label);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("shows a clear keyboard focus indicator on named controls", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    skipUnlessMobile(page);
    const fixture = await seedMobileSession(page, sessionsDir, testInfo);
    try {
      await collapseRightSidebar(page);
      await waitForHome(page);

      const search = page.locator(".mobile-thumb-search");
      await expect(search).toHaveAccessibleName(/\S/);
      await expectVisibleFocus(search);

      await openSeededSession(page, fixture.name);
      const actions = page.locator("#command-menu-btn");
      await expect(actions).toHaveAccessibleName(/\S/);
      await expectVisibleFocus(actions);
    } finally {
      await fixture.cleanup();
    }
  });

  test("reflows at 200% zoom without horizontal clipping", async ({ page }) => {
    skipUnlessMobile(page);
    await waitForHome(page);

    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );

    const result = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const selectors = [
        ".header",
        ".home-layout",
        ".mobile-thumb-bar",
        ".mobile-thumb-search",
        ".mobile-thumb-new",
        ".mobile-thumb-menu",
      ];
      const clipped = selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector))
          .filter((element) => {
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden";
          })
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left < -1 || rect.right > viewportWidth + 1;
          })
          .map((element) => element.className || element.tagName),
      );
      return {
        rootOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
        clipped,
      };
    });

    expect(result.rootOverflow).toBeLessThanOrEqual(1);
    expect(result.bodyOverflow).toBeLessThanOrEqual(1);
    expect(result.clipped).toEqual([]);
  });

  test("removes decorative motion when reduced motion is requested", async ({
    page,
  }) => {
    skipUnlessMobile(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await waitForHome(page);

    const motion = await page
      .locator(".mobile-thumb-bar")
      .evaluate((element) => {
        const style = getComputedStyle(element);
        const buttonStyle = getComputedStyle(element.querySelector("button")!);
        return {
          mediaMatches: matchMedia("(prefers-reduced-motion: reduce)").matches,
          animationName: style.animationName,
          transitionDuration: style.transitionDuration,
          buttonAnimationName: buttonStyle.animationName,
          buttonTransitionDuration: buttonStyle.transitionDuration,
        };
      });

    expect(motion.mediaMatches).toBe(true);
    expect(motion.animationName).toBe("none");
    expect(motion.transitionDuration).toBe("0s");
    expect(motion.buttonAnimationName).toBe("none");
    expect(motion.buttonTransitionDuration).toBe("0s");
  });

  test("uses the opaque no-blur material fallback in forced colors", async ({
    page,
    browserName,
  }) => {
    skipUnlessMobile(page);
    test.skip(
      browserName !== "chromium",
      "Playwright forced-colors emulation is Chromium-only",
    );
    await page.emulateMedia({ forcedColors: "active" });
    await waitForHome(page);

    const fallback = await page.locator(".header").evaluate((element) => {
      const style = getComputedStyle(element);
      const color = style.backgroundColor;
      const alphaMatch = color.match(/rgba?\([^)]*[, /]([\d.]+)\)$/);
      const alpha =
        color.startsWith("rgba") && alphaMatch ? Number(alphaMatch[1]) : 1;
      return {
        mediaMatches: matchMedia("(forced-colors: active)").matches,
        backdropFilter: style.backdropFilter,
        webkitBackdropFilter: style.getPropertyValue("-webkit-backdrop-filter"),
        boxShadow: style.boxShadow,
        backgroundColor: color,
        alpha,
      };
    });

    expect(fallback.mediaMatches).toBe(true);
    expect(["", "none"]).toContain(fallback.backdropFilter);
    expect(["", "none"]).toContain(fallback.webkitBackdropFilter);
    expect(fallback.boxShadow).toBe("none");
    expect(fallback.backgroundColor).not.toBe("transparent");
    expect(fallback.alpha).toBe(1);
  });
});
