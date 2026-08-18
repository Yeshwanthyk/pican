import { readFileSync } from "node:fs";
import { test as base, expect } from "@playwright/test";
import { STATE_FILE, type ServerState } from "./paths";

function readState(): ServerState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

interface Fixtures {
  /** Absolute path to the temp sessions dir the server watches (for mutating tests). */
  sessionsDir: string;
}

export const test = base.extend<Fixtures>({
  // Override baseURL from the running server discovered in global-setup.
  baseURL: async ({}, use) => {
    await use(readState().baseURL);
  },
  sessionsDir: async ({}, use) => {
    await use(readState().sessionsDir);
  },
  // Mirror the server-seeded "show all" artifact filter before page scripts run
  // so the synchronous pre-hydration read is deterministic.
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        // Filter tests override this with their own init script.
        localStorage.setItem("pican:v1:artifacts:include", "");
      } catch {
        /* ignore */
      }
    });
    await use(page);
  },
});

/**
 * Resolve the active layout at runtime. Layout follows the 900px breakpoint,
 * not the device type — iPad portrait (810px) is mobile, landscape (~1080px)
 * is desktop — so callers must check this AFTER navigating to a real page
 * (matchMedia on about:blank does not reflect the project viewport).
 */
export async function isMobileLayout(
  page: import("@playwright/test").Page,
): Promise<boolean> {
  return page.evaluate(() => window.matchMedia("(max-width: 900px)").matches);
}

/**
 * Start with the right sidebar collapsed. On narrow viewports it otherwise
 * overlays the header/composer and intercepts clicks. Must be called before
 * navigating (it installs an init script read by the page's bootstrap).
 */
export async function collapseRightSidebar(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("pican:v1:right-sidebar-collapsed", "true");
    } catch {
      /* ignore */
    }
  });
}

/**
 * Wait until the session app has rendered its first message entry — a
 * readiness gate that does not depend on the tree overlay being open (the
 * conversation tree is an on-demand FullScreenSheet, not a persistent
 * sidebar; its nodes are absent from the DOM until opened).
 */
export async function waitForSessionReady(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.locator('#messages [id^="entry-"]').first().waitFor({ state: "attached" });
}

/**
 * Open the on-demand session tree overlay via the header toggle and wait for
 * its sheet to be visible. Dispatched directly to the button (not `.click()`)
 * because on narrow viewports the long session title shares the header row
 * and wins coordinate hit-testing at the button's center.
 */
export async function openTree(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.locator("#tree-toggle").dispatchEvent("click");
  await page.locator(".tree-sheet-panel").waitFor({ state: "visible" });
}

export { expect };
