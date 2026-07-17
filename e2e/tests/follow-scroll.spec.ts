import { test, expect, collapseScratchpad } from "../lib/test";
import {
  assistantTextEntry,
  buildSession,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";

// Regression for the "scroll to bottom" button appearing after the agent
// finishes even though the viewport is already pinned to the bottom.
//
// Mechanism: when the streaming chat preview is finalized/cleared the scroll
// container (#content) shrinks, so the browser clamps scrollTop downward and
// dispatches a `scroll` event. The follow controller used to read that downward
// clamp as the user scrolling up — flipping its cached `following` flag false
// while we were still at the bottom — and then surfaced the button. The fix
// keeps follow engaged when the clamp leaves us at the bottom (web/src/session/
// live/live-follow.js) and decides the button on the live scroll position
// (live-events.js). Here we reproduce that relayout by adding then removing a
// tall spacer while pinned to the bottom, which produces the same clamp.
test.describe("follow scroll", () => {
  test("downward clamp at the bottom does not surface the scroll-to-bottom button", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const { entries, lastId } = buildSession();
    // Make #content much taller than its viewport so it is actually scrollable
    // and the follow-scroll logic is engaged.
    const tall = Array.from({ length: 80 }, (_, i) => `Filler line ${i}.`).join("\n\n");
    const { entry: tallEntry } = assistantTextEntry(lastId, tall);
    entries.push(tallEntry);
    const name = uniqueSessionName(testInfo, "follow");
    const id = writeSession(sessionsDir, name, entries);

    await collapseScratchpad(page);
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator("#messages")).toContainText("Filler line 0.");

    // #content is the active scroll container in this app (the window itself is
    // not scrollable). Confirm it actually overflows before relying on it.
    expect(
      await page.evaluate(() => {
        const c = document.getElementById("content");
        return !!c && c.scrollHeight > c.clientHeight;
      }),
    ).toBe(true);

    // Add a tall spacer and pin #content to the very bottom so the controller
    // records that we are following at the bottom.
    await page.evaluate(() => {
      const messages = document.getElementById("messages");
      const spacer = document.createElement("div");
      spacer.id = "e2e-clamp-spacer";
      spacer.style.height = "1500px";
      messages?.appendChild(spacer);
      const content = document.getElementById("content");
      if (content) content.scrollTop = content.scrollHeight;
    });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const c = document.getElementById("content");
          return c ? c.scrollHeight - c.scrollTop - c.clientHeight < 80 : false;
        }),
      )
      .toBe(true);

    // Remove the spacer: #content shrinks, scrollTop is clamped downward, and the
    // browser dispatches a `scroll` event — the exact bug trigger.
    await page.evaluate(() => {
      document.getElementById("e2e-clamp-spacer")?.remove();
    });

    // We never left the bottom, so the follow button must not appear. Poll for a
    // beat so a delayed clamp event still has time to (wrongly) create it.
    await expect(page.locator(".follow-button")).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(page.locator(".follow-button")).toHaveCount(0);

    // Sanity: we are still pinned at the bottom after the clamp.
    expect(
      await page.evaluate(() => {
        const c = document.getElementById("content");
        return c ? c.scrollHeight - c.scrollTop - c.clientHeight < 80 : false;
      }),
    ).toBe(true);
  });
});
