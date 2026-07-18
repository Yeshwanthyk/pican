import { test, expect, waitForSessionReady } from "../lib/test";
import {
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// The diff viewer (@pierre/diffs) ships a heavy shiki + worker renderer. Verify
// the actual rendering on Desktop Chrome only — the mobile layout uses a
// different command-menu surface, and cross-browser worker/highlighter behavior
// is out of scope and prone to flake. testInfo is only available inside hooks,
// not in module-level test.skip, so gate via beforeEach.
test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "Desktop Chrome",
    "diff renderer is verified on Desktop Chrome only",
  );
});

/** A temp git repo with one committed file, an uncommitted edit, and an untracked file. */
function gitRepoWithChanges(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-e2e-gitdiff-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@e2e.test");
  git("config", "user.name", "E2E");
  writeFileSync(join(dir, "hello.txt"), "line one\nline two\nline three\n");
  git("add", "hello.txt");
  git("commit", "-q", "-m", "add hello");
  writeFileSync(join(dir, "hello.txt"), "line one\nCHANGED two\nline three\n");
  writeFileSync(join(dir, "newfile.txt"), "fresh content\nsecond line\n");
  return dir;
}

async function openDiffModal(page: Page) {
  await waitForSessionReady(page);
  await page.locator("#command-menu-btn").click();
  await page.locator('#command-menu-popover [data-action="diff"]').click();
  await expect(page.locator(".diff-toolbar")).toBeVisible();
}

test.describe("diff review modal", () => {
  test("renders the working-tree diff full-page with a split/unified toggle", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const { entries } = buildSession({ cwd: gitRepoWithChanges() });
    const name = uniqueSessionName(testInfo, "diff");
    writeSession(sessionsDir, name, entries);

    await page.goto(`/session?id=${encodeURIComponent(name)}`);
    await openDiffModal(page);

    // The renderer mounts a <diffs-container> custom element per file once the
    // diff + highlighter finish loading.
    await expect(
      page.locator(".diff-codeview diffs-container").first(),
    ).toBeVisible({
      timeout: 15000,
    });

    // The sheet should fill the viewport, not sit as a small centered dialog.
    const panel = page.locator(".diff-sheet-panel");
    const box = await panel.boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.width).toBeGreaterThan(
      viewport!.width * 0.95,
    );
    expect(box && viewport && box.height).toBeGreaterThan(
      viewport!.height * 0.95,
    );

    // Toggle to unified and confirm the renderer is still present.
    await page.locator(".diff-toggle-btn", { hasText: "Unified" }).click();
    await expect(
      page.locator(".diff-codeview diffs-container").first(),
    ).toBeVisible();
  });

  test("shows a not-a-repo message when the session cwd is not a git repo", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const { entries } = buildSession({ cwd: realWorkingDir() });
    const name = uniqueSessionName(testInfo, "diffnorepo");
    writeSession(sessionsDir, name, entries);

    await page.goto(`/session?id=${encodeURIComponent(name)}`);
    await openDiffModal(page);

    await expect(page.locator(".diff-status")).toContainText(
      "Not a git repository",
    );
  });

  test("re-themes the diff when the app theme changes", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const { entries } = buildSession({ cwd: gitRepoWithChanges() });
    const name = uniqueSessionName(testInfo, "difftheme");
    writeSession(sessionsDir, name, entries);

    await page.goto(`/session?id=${encodeURIComponent(name)}`);
    await openDiffModal(page);
    const container = page.locator(".diff-codeview diffs-container").first();
    await expect(container).toBeVisible({ timeout: 15000 });

    const colorScheme = () =>
      page.evaluate(
        () =>
          getComputedStyle(
            document.querySelector(
              ".diff-codeview diffs-container",
            ) as HTMLElement,
          ).colorScheme,
      );

    await expect.poll(colorScheme).toBe("dark");
    await page.evaluate(
      () => (document.documentElement.dataset.theme = "light"),
    );
    await expect.poll(colorScheme).toBe("light");
  });

  test("collapses and expands a single file via its header chevron", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const { entries } = buildSession({ cwd: gitRepoWithChanges() });
    const name = uniqueSessionName(testInfo, "diffcollapse");
    writeSession(sessionsDir, name, entries);

    await page.goto(`/session?id=${encodeURIComponent(name)}`);
    await openDiffModal(page);
    const container = page.locator(".diff-codeview diffs-container").first();
    await expect(container).toBeVisible({ timeout: 15000 });

    // hello.txt body shows the edited line until collapsed.
    await expect(container.getByText("CHANGED two")).toBeVisible();

    // Header chevron is rendered via renderHeaderPrefix with an aria-label
    // that flips between "Collapse file" and "Expand file".
    await container.locator('button[aria-label="Collapse file"]').click();
    await expect(container.getByText("CHANGED two")).toBeHidden();

    await container.locator('button[aria-label="Expand file"]').click();
    await expect(container.getByText("CHANGED two")).toBeVisible();
  });

  test("collapses every file with one toolbar click and re-expands them", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const { entries } = buildSession({ cwd: gitRepoWithChanges() });
    const name = uniqueSessionName(testInfo, "diffcollapseall");
    writeSession(sessionsDir, name, entries);

    await page.goto(`/session?id=${encodeURIComponent(name)}`);
    await openDiffModal(page);
    const containers = page.locator(".diff-codeview diffs-container");
    await expect(containers.first()).toBeVisible({ timeout: 15000 });
    // Two files: modified hello.txt + untracked newfile.txt.
    await expect(containers).toHaveCount(2);
    await expect(containers.first().getByText("CHANGED two")).toBeVisible();
    await expect(containers.nth(1).getByText("fresh content")).toBeVisible();

    // Toolbar toggle starts as "Collapse all" and flips to "Expand all" once
    // every file is collapsed (derived from collapsedCount vs fileCount).
    const toggle = page.locator(".diff-toolbar-btn");
    await expect(toggle).toHaveText("Collapse all");
    await toggle.click();

    await expect(toggle).toHaveText("Expand all");
    await expect(containers.first().getByText("CHANGED two")).toBeHidden();
    await expect(containers.nth(1).getByText("fresh content")).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveText("Collapse all");
    await expect(containers.first().getByText("CHANGED two")).toBeVisible();
    await expect(containers.nth(1).getByText("fresh content")).toBeVisible();
  });
});
