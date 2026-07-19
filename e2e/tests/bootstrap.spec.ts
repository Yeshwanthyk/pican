import { test, expect, openTree } from "../lib/test";
import {
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";

// The /session shell embeds the session payload in <script id="pican-session-bootstrap">
// so the SPA paints the first frame without a round-trip to /api/session.
test.describe("session bootstrap (embedded payload)", () => {
  test("renders from the embedded payload without a full /api/session fetch", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const { entries } = buildSession({ cwd: realWorkingDir() });
    const id = writeSession(sessionsDir, uniqueSessionName(testInfo, "boot"), entries);

    const apiSessionCalls: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname === "/api/session" && !u.searchParams.has("afterCount")) {
        apiSessionCalls.push(u.search);
      }
    });

    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator("#messages")).toContainText("Initial");

    const hasBootstrap = await page.evaluate(
      () => !!document.getElementById("pican-session-bootstrap")?.textContent,
    );
    expect(hasBootstrap).toBe(true);
    // Initial paint comes from the embed — no full /api/session GET on load.
    // An SSE event may race the assertion and legitimately request an
    // afterCount reconciliation against that embedded payload.
    expect(apiSessionCalls).toEqual([]);

    await openTree(page);
    await expect(page.locator("#tree-container .tree-node").first()).toBeVisible();
  });
});
