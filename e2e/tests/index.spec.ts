import { test, expect, isMobileLayout } from "../lib/test";

test.describe("sessions index", () => {
  test("renders a card per fixture session", async ({ page }) => {
    await page.goto("/");

    const demo = page.locator(".session-ticker-row", { hasText: "add deepseek-v4-pro" });
    const notes = page.locator(".session-ticker-row", { hasText: "Fix the failing unit test" });

    await expect(demo).toBeVisible();
    await expect(notes).toBeVisible();
  });

  test("groups cards by sanitized project path in Projects layout", async ({ page }) => {
    await page.goto("/");

    // Layout is a server-synced preference shared by the E2E server. Other
    // projects can change it concurrently, so retry the user action until this
    // page has observed Projects rather than assuming one click wins the race.
    await expect(async () => {
      if (
        (await page.locator("[data-sessions-content]").getAttribute("data-layout")) === "projects"
      ) {
        return;
      }
      if (await isMobileLayout(page)) {
        await page.locator("#web-menu-btn-mobile").click();
        await page.locator("[data-layout-menu-btn]").click();
      } else {
        await page.locator('[data-layout-btn="projects"]').click();
      }
      await expect(page.locator("[data-sessions-content]")).toHaveAttribute(
        "data-layout",
        "projects",
        { timeout: 2000 },
      );
    }).toPass({ timeout: 15000 });

    await expect(
      page.locator('.project-group[data-project="/home/user/demo-project"]'),
    ).toBeVisible();
    await expect(
      page.locator('.project-group[data-project="/home/user/notes-app"]'),
    ).toBeVisible();
  });

  test("card links to its session view", async ({ page }) => {
    await page.goto("/");

    // The index re-renders the cards once its initial refresh finishes (marked
    // by .index-layout-ready). Clicking before that can land on a card that's
    // replaced mid-click, so the navigation never fires. Wait for it to settle.
    await page.locator("[data-sessions-content].index-layout-ready").waitFor();

    const notes = page.locator(".session-ticker-row", { hasText: "Fix the failing unit test" });
    const link = notes.locator(".session-ticker-link");
    await expect(link).toHaveAttribute("href", /\/session\?id=/);

    // The shared SSE fixture can replace index rows while other projects create
    // sessions. Re-locate and retry the real click if it lands on a detached row.
    await expect(async () => {
      await link.click();
      await expect(page).toHaveURL(/\/session\?id=/, { timeout: 2000 });
    }).toPass({ timeout: 15000 });
  });
});
