import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { tick } from "svelte";
import { cleanup, render } from "@testing-library/svelte";
import RightSidebar from "./RightSidebar.svelte";
import { sessionRuntime, resetSessionRuntime } from "../../session/session-runtime.js";

function query<ElementType extends Element = HTMLElement>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  assert(element);
  return element;
}

function byId(elementId: string): HTMLElement {
  const element = document.getElementById(elementId);
  assert(element);
  return element;
}

afterEach(() => {
  cleanup();
  document.body.className = "";
  document.documentElement.removeAttribute("style");
  localStorage.clear();
  resetSessionRuntime();
});

beforeEach(() => {
  document.body.className = "";
  localStorage.clear();
});

describe("RightSidebar tabs", () => {
  it("renders the artifacts tab active by default", async () => {
    render(RightSidebar);
    await tick();

    expect(query('[data-pane="artifacts"]').classList.contains("active")).toBe(true);
    expect(query('[data-pane="artifacts"]').getAttribute("aria-selected")).toBe("true");
    expect(byId("right-pane-artifacts").hasAttribute("hidden")).toBe(false);
  });

  it("persists the active tab and restores it on the next mount", async () => {
    render(RightSidebar);
    query<HTMLElement>('[data-pane="artifacts"]').click();
    await tick();
    expect(localStorage.getItem("pican:v1:right-sidebar-tab")).toBe("artifacts");
    cleanup();

    render(RightSidebar);
    await tick();
    expect(byId("right-pane-artifacts").hasAttribute("hidden")).toBe(false);
    expect(query('[data-pane="artifacts"]').classList.contains("active")).toBe(true);
  });

  it("marks the active tab on the sidebar for tab-scoped chrome", async () => {
    render(RightSidebar);
    expect(byId("right-sidebar").dataset.activeTab).toBe("artifacts");
  });

  it("ignores activation for an unknown pane name via the window bridge", async () => {
    render(RightSidebar);
    const activateTab = sessionRuntime.rightSidebar?.activateTab;
    assert(activateTab);
    activateTab("nonexistent");
    await tick();
    expect(query('[data-pane="artifacts"]').classList.contains("active")).toBe(true);
    expect(byId("right-pane-artifacts").hasAttribute("hidden")).toBe(false);
  });
});

describe("RightSidebar visibility controls", () => {
  it("exposes toggle/open/collapse on the window bridge that drive body classes", () => {
    document.body.classList.add("right-sidebar-collapsed");
    render(RightSidebar);

    const runtime = sessionRuntime.rightSidebar;
    assert(runtime?.open);
    assert(runtime.collapse);
    assert(runtime.toggle);
    runtime.open();
    expect(document.body.classList.contains("right-sidebar-collapsed")).toBe(false);

    runtime.collapse();
    expect(document.body.classList.contains("right-sidebar-collapsed")).toBe(true);

    runtime.toggle();
    expect(document.body.classList.contains("right-sidebar-collapsed")).toBe(false);
  });

  it("close button hides the sidebar and exits expand mode", async () => {
    document.body.classList.add("right-sidebar-expanded");
    render(RightSidebar);
    byId("close-right-sidebar").click();
    await tick();
    expect(document.body.classList.contains("right-sidebar-collapsed")).toBe(true);
    expect(document.body.classList.contains("right-sidebar-expanded")).toBe(false);
  });
});
