import { rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { test, expect } from "../lib/test";
import {
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";

interface TrackedHomeFixture {
  readonly projects: readonly [string, string];
  readonly sessionNames: readonly [string, string];
  cleanup(): Promise<void>;
}

async function seedTrackedHome(
  page: Page,
  sessionsDir: string,
  testInfo: TestInfo,
): Promise<TrackedHomeFixture> {
  const projects = [realWorkingDir(), realWorkingDir()] as const;
  const sessionNames = [
    "Tracked demo activity",
    "Tracked notes activity",
  ] as const;
  const filenames: string[] = [];

  for (const [index, path] of projects.entries()) {
    const fixture = buildSession({ cwd: path });
    const entries = fixture.entries.map((entry, entryIndex) =>
      entryIndex === 0 ? { ...entry, name: sessionNames[index] } : entry,
    );
    const filename = uniqueSessionName(testInfo, `tracked-home-${index}`);
    filenames.push(writeSession(sessionsDir, filename, entries));
    const response = await page.request.post("/api/projects", {
      data: { action: "track", path },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  return {
    projects,
    sessionNames,
    async cleanup() {
      for (const path of projects) {
        await page.request.post("/api/projects", {
          data: { action: "untrack", path },
        });
        rmSync(path, { recursive: true, force: true });
      }
      for (const filename of filenames) {
        try {
          unlinkSync(join(sessionsDir, "--home-user-demo-project--", filename));
        } catch {
          // The test server cleanup owns any file that has already disappeared.
        }
      }
    },
  };
}

test.describe("sessions index", () => {
  test("renders the tracked-project Home contract as compact activity rows", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const fixture = await seedTrackedHome(page, sessionsDir, testInfo);
    try {
      const projectsResponse = await page.request.get("/api/projects");
      expect(projectsResponse.ok()).toBeTruthy();
      const projects = (await projectsResponse.json()) as {
        projects: Array<{ path: string; tracked: boolean }>;
      };
      for (const path of fixture.projects) {
        expect(
          projects.projects.find((project) => project.path === path)?.tracked,
        ).toBe(true);
      }

      await page.goto("/");
      await page
        .locator("[data-sessions-content].index-layout-ready")
        .waitFor();

      for (const [index, path] of fixture.projects.entries()) {
        const group = page.locator(`.activity-group[data-project="${path}"]`);
        await expect(group).toBeVisible();
        await expect(
          group.locator(".activity-row", {
            hasText: fixture.sessionNames[index],
          }),
        ).toBeVisible();
      }
      await expect(page.locator(".session-card")).toHaveCount(0);
    } finally {
      await fixture.cleanup();
    }
  });

  test("keeps the core Home hierarchy semantic and ordered", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const fixture = await seedTrackedHome(page, sessionsDir, testInfo);
    try {
      await page.goto("/");
      await page
        .locator("[data-sessions-content].index-layout-ready")
        .waitFor();

      const headings = await page
        .getByRole("heading", { level: 2 })
        .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
      expect(headings).toEqual(
        ["Pinned", "Projects"].filter((heading) =>
          headings.includes(heading),
        ),
      );
      expect(headings.at(-1)).toBe("Projects");
      for (const path of fixture.projects) {
        const heading = page.getByRole("heading", {
          level: 3,
          name: basename(path),
        });
        await expect(heading).toBeVisible();
        await expect(heading.locator("a")).toHaveAttribute("title", path);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test("activity row links to its session view", async ({
    page,
    sessionsDir,
  }, testInfo) => {
    const fixture = await seedTrackedHome(page, sessionsDir, testInfo);
    try {
      await page.goto("/");
      await page
        .locator("[data-sessions-content].index-layout-ready")
        .waitFor();

      const project = page.locator(
        `.activity-group[data-project="${fixture.projects[1]}"]`,
      );
      const row = project.locator(".activity-row", {
        hasText: fixture.sessionNames[1],
      });
      const link = row.locator(".activity-row-link");
      await expect(link).toHaveAttribute("href", /\/session\?id=/);

      await expect(async () => {
        await link.click();
        await expect(page).toHaveURL(/\/session\?id=/, { timeout: 2000 });
      }).toPass({ timeout: 15000 });
    } finally {
      await fixture.cleanup();
    }
  });
});
