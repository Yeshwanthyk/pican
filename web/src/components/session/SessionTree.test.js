import { afterEach, describe, expect, it } from "vitest";
import { tick } from "svelte";
import { render, cleanup, screen } from "@testing-library/svelte";
import SessionTree from "./SessionTree.svelte";

afterEach(cleanup);

describe("SessionTree (over FullScreenSheet)", () => {
  it("renders the tree sheet with search and filter controls when open", async () => {
    render(SessionTree, { props: { open: true } });
    await tick();
    const panel = document.querySelector(".pi-sheet-panel");
    expect(panel).toBeTruthy();
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // the five tree filter buttons (default/no-tools/user/labeled/all)
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(5);
    expect(document.getElementById("tree-container")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(SessionTree, { props: { open: false } });
    expect(document.querySelector(".pi-sheet-panel")).toBeFalsy();
  });
});
