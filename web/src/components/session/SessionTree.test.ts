import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup, screen } from "@testing-library/svelte";
import { SessionDataModel } from "../../session/data/session-data.svelte.js";

afterEach(() => {
  cleanup();
});

async function renderTree(open: boolean) {
  const model = new SessionDataModel({ entries: [], header: {}, leafId: "" });
  vi.doMock("../../session/session-context.js", () => ({
    getSessionModel: () => model,
    setSessionModel: <Model>(value: Model) => value,
  }));
  const { default: SessionTree } = await import("./SessionTree.svelte");
  return render(SessionTree, { props: { open } });
}

describe("SessionTree (over FullScreenSheet)", () => {
  it("renders the tree sheet with search and filter controls when open", async () => {
    await renderTree(true);
    await tick();
    const panel = document.querySelector(".pi-sheet-panel");
    expect(panel).toBeTruthy();
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // the five tree filter buttons (default/no-tools/user/labeled/all)
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(5);
    expect(document.getElementById("tree-container")).toBeInTheDocument();
  });

  it("renders nothing when closed", async () => {
    await renderTree(false);
    expect(document.querySelector(".pi-sheet-panel")).toBeFalsy();
  });
});
