import { test, expect, isMobileLayout, collapseScratchpad } from "../lib/test";
import type { Page } from "@playwright/test";

// Layout is driven by the 900px breakpoint, not by device type: iPad portrait
// (810px) lands on mobile, iPad landscape (~1080px) on desktop. Each test
// resolves the active layout at runtime (after navigation) and skips the half
// that doesn't apply, so every project runs exactly the relevant assertions.
//
// The session tree is an on-demand FullScreenSheet overlay (bottom sheet on
// mobile, centered dialog on desktop) rather than a persistent docked
// sidebar — see SessionTree.svelte / session-modals.svelte.js.

async function openDemoSession(page: Page) {
  // Keep the scratchpad collapsed so it doesn't overlay the header on narrow
  // viewports; we're exercising the tree overlay.
  await collapseScratchpad(page);
  await page.goto("/");
  await page
    .locator(".session-ticker-row", { hasText: "add deepseek-v4-pro" })
    .locator(".session-ticker-link")
    .click();
  await expect(page).toHaveURL(/\/session\?id=/);
  await page.locator("#tree-toggle").waitFor();
}

test.describe("session tree overlay", () => {
  test("opens as a sheet via the header toggle and closes on node selection", async ({
    page,
  }) => {
    await openDemoSession(page);
    const mobile = await isMobileLayout(page);

    const panel = page.locator(".tree-sheet-panel");
    await expect(panel).toBeHidden();

    // Dispatch the click straight to the button: the long session title shares
    // the narrow header row and wins coordinate hit-testing at the button's
    // center (even force-click lands on the title) on mobile.
    await page.locator("#tree-toggle").dispatchEvent("click");
    await expect(panel).toBeVisible();

    if (mobile) {
      // Bottom sheet: fills the viewport width.
      const box = await panel.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport && box.width).toBeGreaterThan(viewport!.width * 0.95);
    } else {
      // Centered dialog: does not fill the viewport.
      const box = await panel.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport && box.width).toBeLessThan(viewport!.width * 0.9);
    }

    // Selecting a node navigates AND closes the overlay, on every viewport.
    await page.locator("#tree-container .tree-node").first().click();
    await expect(panel).toBeHidden();
  });

  test("Cmd+B toggles the tree overlay open and closed", async ({ page }) => {
    await openDemoSession(page);
    const panel = page.locator(".tree-sheet-panel");
    await expect(panel).toBeHidden();

    await page.keyboard.press("Meta+b");
    await expect(panel).toBeVisible();

    await page.keyboard.press("Meta+b");
    await expect(panel).toBeHidden();
  });

  test("?tree=open restores the overlay on load", async ({ page }) => {
    await collapseScratchpad(page);
    await page.goto("/");
    await page
      .locator(".session-ticker-row", { hasText: "add deepseek-v4-pro" })
      .locator(".session-ticker-link")
      .click();
    await expect(page).toHaveURL(/\/session\?id=/);
    const url = new URL(page.url());
    url.searchParams.set("tree", "open");

    await page.goto(url.toString());
    await expect(page.locator(".tree-sheet-panel")).toBeVisible();
  });
});
