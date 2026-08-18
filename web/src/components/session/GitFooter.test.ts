import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import GitFooter from "./GitFooter.svelte";
import type { GitInfo } from "../../lib/schema.js";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const id = (elementId: string): HTMLElement => {
  const element = document.getElementById(elementId);
  assert(element);
  return element;
};
const inputById = (elementId: string): HTMLInputElement => {
  const element = document.querySelector<HTMLInputElement>(`#${elementId}`);
  assert(element);
  return element;
};
const gitInfo = (overrides: Partial<GitInfo>): GitInfo => ({
  isRepo: true,
  branch: "",
  isDefault: false,
  hasChanges: false,
  prCreateUrl: "",
  prUrl: "",
  ...overrides,
});

interface GitApiFixture {
  readonly getGitInfo: (sessionId: string) => Promise<GitInfo>;
  readonly renameBranch?: (sessionId: string, name: string) => Promise<unknown>;
}

// GitFooter wires the composer's textarea (#pi-chat-message), which lives in
// <ChatComposer>, not in GitFooter itself — provide one for the prompt-insert
// assertions.
let textarea: HTMLTextAreaElement | undefined;
function renderFooter(gitApi: GitApiFixture): void {
  textarea = document.createElement("textarea");
  textarea.id = "pi-chat-message";
  document.body.appendChild(textarea);
  render(GitFooter, { props: { sessionId: "s", gitApi } });
}

afterEach(() => {
  cleanup();
  textarea?.remove();
  textarea = undefined;
  vi.restoreAllMocks();
});

describe("GitFooter", () => {
  it("hides the whole bar when the cwd is not a git repo", async () => {
    renderFooter({ getGitInfo: vi.fn().mockResolvedValue(gitInfo({ isRepo: false })) });
    await flush();
    expect(id("pi-git-bar").hidden).toBe(true);
    expect(id("pi-git-branch").hidden).toBe(true);
    expect(id("pi-git-pr").hidden).toBe(true);
  });

  it("feature branch, no PR -> primary Create PR (commit+push+create), only manual under the caret", async () => {
    renderFooter({
      getGitInfo: vi.fn().mockResolvedValue(
        gitInfo({
          isRepo: true,
          branch: "feature/x",
          isDefault: false,
          hasChanges: true,
          prUrl: "",
        }),
      ),
    });
    await flush();
    expect(id("pi-git-primary-label").textContent).toBe("Create PR");
    expect(id("pi-git-branch-edit").hidden).toBe(false);
    expect(id("pi-git-caret").hidden).toBe(false);
    expect(id("pi-git-pr-manual").hidden).toBe(false);
    expect(id("pi-git-pr-view").hidden).toBe(true);
    expect(id("pi-git-pr-merge").hidden).toBe(true);
    id("pi-git-primary").click();
    expect(textarea?.value).toContain("gh pr create --draft");
  });

  it("feature branch, open PR -> primary View PR, secondary merge only (regardless of changes)", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderFooter({
      getGitInfo: vi.fn().mockResolvedValue(
        gitInfo({
          isRepo: true,
          branch: "feature/x",
          isDefault: false,
          hasChanges: true,
          prUrl: "https://github.com/o/r/pull/42",
        }),
      ),
    });
    await flush();
    expect(id("pi-git-primary-label").textContent.trim()).toBe("View PR");
    expect(id("pi-git-primary-label").querySelector("svg")).not.toBeNull();
    expect(id("pi-git-pr-merge").hidden).toBe(false);
    expect(id("pi-git-pr-draft").hidden).toBe(true);
    expect(id("pi-git-pr-manual").hidden).toBe(true);
    id("pi-git-primary").click();
    expect(open).toHaveBeenCalledWith("https://github.com/o/r/pull/42", "_blank", "noopener");
  });

  it("default branch -> action control hidden, only the branch shows", async () => {
    renderFooter({
      getGitInfo: vi
        .fn()
        .mockResolvedValue(gitInfo({ branch: "main", isDefault: true, hasChanges: true })),
    });
    await flush();
    expect(id("pi-git-bar").hidden).toBe(false);
    expect(id("pi-git-pr").hidden).toBe(true);
    expect(id("pi-git-primary").hidden).toBe(true);
    expect(id("pi-git-caret").hidden).toBe(true);
    expect(id("pi-git-branch-edit").hidden).toBe(true);
  });

  it("menu items run their actions (Merge PR injects merge prompt)", async () => {
    renderFooter({
      getGitInfo: vi.fn().mockResolvedValue(
        gitInfo({
          isRepo: true,
          branch: "feature/x",
          isDefault: false,
          hasChanges: true,
          prUrl: "https://github.com/o/r/pull/42",
        }),
      ),
    });
    await flush();
    id("pi-git-pr-merge").click();
    expect(textarea?.value).toContain("gh pr merge");
  });

  it("renames the branch and refreshes", async () => {
    const renameBranch = vi.fn().mockResolvedValue({ ok: true, branch: "renamed" });
    const getGitInfo = vi
      .fn()
      .mockResolvedValueOnce(gitInfo({ branch: "old" }))
      .mockResolvedValueOnce(gitInfo({ branch: "renamed" }));
    renderFooter({ getGitInfo, renameBranch });
    await flush();

    id("pi-git-branch-edit").click();
    const input = inputById("pi-git-branch-input");
    expect(input.hidden).toBe(false);
    input.value = "renamed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await flush();

    expect(renameBranch).toHaveBeenCalledWith("s", "renamed");
    expect(id("pi-git-branch-name").textContent).toBe("renamed");
  });
});
