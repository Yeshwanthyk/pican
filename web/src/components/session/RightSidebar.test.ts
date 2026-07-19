import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { Option, Schema } from "effect";
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
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

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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
  it("switches panes and aria state on tab click", async () => {
    render(RightSidebar);
    query<HTMLElement>('[data-pane="artifacts"]').click();
    await tick();

    expect(query('[data-pane="artifacts"]').classList.contains("active")).toBe(true);
    expect(query('[data-pane="artifacts"]').getAttribute("aria-selected")).toBe("true");
    expect(query('[data-pane="scratchpad"]').getAttribute("aria-selected")).toBe("false");
    expect(byId("right-pane-artifacts").hasAttribute("hidden")).toBe(false);
    expect(byId("right-pane-scratchpad").hasAttribute("hidden")).toBe(true);
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
    expect(byId("right-sidebar").dataset.activeTab).toBe("scratchpad");
    query<HTMLElement>('[data-pane="artifacts"]').click();
    await tick();
    expect(byId("right-sidebar").dataset.activeTab).toBe("artifacts");
  });

  it("ignores activation for an unknown pane name via the window bridge", () => {
    render(RightSidebar);
    const activateTab = sessionRuntime.rightSidebar?.activateTab;
    assert(activateTab);
    activateTab("nonexistent");
    expect(query('[data-pane="scratchpad"]').classList.contains("active")).toBe(true);
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

describe("RightSidebar scratchpad", () => {
  it("auto-loads /api/scratchpad when the prop is empty (SPA-nav path)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ content: "fetched notes" }));
    vi.stubGlobal("fetch", fetchMock);

    render(RightSidebar, { props: { projectPath: "/proj" } });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scratchpad?project=%2Fproj",
      expect.objectContaining({ method: "GET" }),
    );
    await waitFor(() => {
      expect(query<HTMLTextAreaElement>("#scratchpad-textarea").value).toBe("fetched notes");
    });

    vi.unstubAllGlobals();
  });

  it("debounce-saves edits to /api/scratchpad", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => response({}),
    );
    vi.stubGlobal("fetch", fetchMock);

    // Non-empty `scratchpad` keeps RightSidebar on the adopt-baseline path so
    // this test focuses on debounce-save, not the network-path auto-load.
    render(RightSidebar, { props: { projectPath: "/proj", scratchpad: "seed" } });
    const textarea = query<HTMLTextAreaElement>("#scratchpad-textarea");
    textarea.value = "hello notes";
    textarea.dispatchEvent(new Event("input"));

    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/scratchpad",
      expect.objectContaining({ method: "POST" }),
    );
    const firstCall = fetchMock.mock.calls[0];
    assert(firstCall);
    const init = firstCall[1];
    assert(init);
    assert(typeof init.body === "string");
    const body = decodeJson(init.body);
    expect(Option.getOrNull(body)).toEqual({ project: "/proj", content: "hello notes" });

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
