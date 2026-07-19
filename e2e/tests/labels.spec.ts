import { expect, test, openTree } from "../lib/test";
import { buildSession, uniqueSessionName, writeSession } from "../lib/sessions";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test.describe("session labels", () => {
  test("adds a label from the message action bar and shows it in the tree", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const name = uniqueSessionName(testInfo, "labels");
    const { entries, lastId } = buildSession();
    const id = writeSession(sessionsDir, name, entries);

    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator(`#entry-${lastId}`)).toBeVisible();

    await page.locator(`#entry-${lastId} .label-btn`).click({ force: true });
    await page.locator("#label-modal-input").fill("Review checkpoint");
    await page.locator(".label-modal-save").click();

    // The tree is an on-demand overlay; open it so its nodes/filter controls
    // are in the DOM and clickable.
    await page.locator("#tree-toggle").dispatchEvent("click");
    await expect(page.locator(".tree-sheet-panel")).toBeVisible();

    await expect(
      page.locator("#tree-container .tree-label", {
        hasText: "[Review checkpoint]",
      }),
    ).toBeVisible();

    await page.locator('.filter-btn[data-filter="labeled-only"]').click();
    // Ancestors remain visible to preserve the path to the labeled entry.
    const labeledNodes = page.locator("#tree-container .tree-node", {
      has: page.locator(".tree-label"),
    });
    await expect(labeledNodes).toHaveCount(1);
    await expect(labeledNodes).toContainText("Review checkpoint");

    const file = readFileSync(
      join(sessionsDir, "--home-user-demo-project--", name),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const labelEntry = file.find(
      (entry) => entry.type === "label" && entry.targetId === lastId,
    );
    expect(labelEntry).toMatchObject({
      type: "label",
      targetId: lastId,
      label: "Review checkpoint",
    });
  });

  test("removes an existing label from the label modal", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const name = uniqueSessionName(testInfo, "labels-remove");
    const { entries, lastId } = buildSession();
    entries.push({
      type: "label",
      id: "label-existing",
      parentId: lastId,
      timestamp: new Date().toISOString(),
      targetId: lastId,
      label: "Old label",
    });
    const id = writeSession(sessionsDir, name, entries);

    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await openTree(page);
    await expect(
      page.locator("#tree-container .tree-label", { hasText: "[Old label]" }),
    ).toBeVisible();

    // The tree overlay's backdrop covers the message pane; close it before
    // interacting with the entry's label button.
    await page.keyboard.press("Escape");
    await expect(page.locator(".tree-sheet-panel")).toBeHidden();

    await page.locator(`#entry-${lastId} .label-btn`).click({ force: true });
    await expect(page.locator(".label-modal-remove")).toBeVisible();
    await page.locator(".label-modal-remove").click();

    await openTree(page);
    await expect(
      page.locator("#tree-container .tree-label", { hasText: "[Old label]" }),
    ).toHaveCount(0);
    const file = readFileSync(
      join(sessionsDir, "--home-user-demo-project--", name),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const clearEntry = file.at(-1);
    expect(clearEntry).toMatchObject({ type: "label", targetId: lastId });
    expect(clearEntry.label).toBeUndefined();
  });
});
