import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import CommandMenu from "./CommandMenu.svelte";
import { sessionModals, resetSessionModals } from "../../session/session-modals.svelte.js";
import { setSessionPaletteApi } from "../../shared/command-palette-runtime.js";
import { sessionTitle } from "../../session/session-title.svelte.js";

// The menu button (#command-menu-btn) lives in SessionHeader; the menu reads it
// by id, so the test provides it. The session name now flows through the shared
// reactive store, seeded here.
beforeEach(() => {
  document.body.innerHTML = "";
  const btn = document.createElement("button");
  btn.id = "command-menu-btn";
  document.body.appendChild(btn);
  sessionTitle.name = "Old";
  window.history.replaceState({}, "", "/session?id=session.jsonl");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(
      (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      }),
    ),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetSessionModals();
  setSessionPaletteApi(null);
});

describe("CommandMenu", () => {
  it("renames via the API and updates the page title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ name: "New Name" }), { status: 200 })),
      ),
    );
    window.prompt = vi.fn(() => " New Name ");
    render(CommandMenu, { props: { sessionId: "session.jsonl" } });
    await tick();

    await fireEvent.click(document.querySelector('[data-action="rename"]') ?? document.body);
    await waitFor(() => expect(sessionTitle.name).toBe("New Name"));
    expect(fetch).toHaveBeenCalledWith(
      "/api/rename-session?id=session.jsonl",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the old title when the rename API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: "bad" }), { status: 500 }))),
    );
    window.prompt = vi.fn(() => "New Name");
    render(CommandMenu, { props: { sessionId: "session.jsonl" } });
    await tick();

    await fireEvent.click(document.querySelector('[data-action="rename"]') ?? document.body);
    await waitFor(() =>
      expect(document.getElementById("command-menu-toast")?.textContent).toBe("Rename failed"),
    );
    expect(sessionTitle.name).toBe("Old");
  });

  it("opens model usage via the modal store + the session-list palette runtime", async () => {
    const openPalette = vi.fn();
    render(CommandMenu, { props: { sessionId: "s" } });
    await tick();
    setSessionPaletteApi({ open: openPalette });

    await fireEvent.click(document.querySelector('[data-action="model-usage"]') ?? document.body);
    await fireEvent.click(document.querySelector('[data-action="list-sessions"]') ?? document.body);
    expect(sessionModals.modelUsage).toBe(true);
    expect(openPalette).toHaveBeenCalled();
  });

  it("always shows session tool destinations", () => {
    render(CommandMenu, { props: { sessionId: "session.jsonl", cwd: "/repo" } });

    expect(document.querySelectorAll('[data-action="workflows"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-action="tasks"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-action="subagents"]')).toHaveLength(2);
  });

  it("always shows the local archive action independent of runtime capabilities", () => {
    render(CommandMenu, { props: { sessionId: "session.jsonl" } });

    expect(document.querySelectorAll('[data-action="archive"]')).toHaveLength(2);
    expect(document.querySelector('[data-action="archive"]')).toHaveTextContent(
      "Archive this session",
    );
  });

  it.each([
    [{ running: true }, "Stop this session before archiving it."],
    [{ waiting: true }, "Answer this session before archiving it."],
  ])("disables archive while active with the precise reason", (activity, reason) => {
    render(CommandMenu, { props: { sessionId: "session.jsonl", ...activity } });

    const archive = document.querySelector<HTMLButtonElement>('[data-action="archive"]');
    expect(archive).toBeDisabled();
    expect(archive).toHaveAttribute("title", reason);
  });

  it("archives through pican and navigates home only after success", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(CommandMenu, { props: { sessionId: "session.jsonl" } });
    await tick();

    await fireEvent.click(document.querySelector('[data-action="archive"]') ?? document.body);
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/archives",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionId: "session.jsonl", archived: true }),
      }),
    );
  });

  it("restores in place and propagates the new local state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))),
    );
    const onArchiveChange = vi.fn();
    render(CommandMenu, {
      props: { sessionId: "session.jsonl", archived: true, onArchiveChange },
    });
    await tick();

    await fireEvent.click(document.querySelector('[data-action="archive"]') ?? document.body);
    await waitFor(() => expect(onArchiveChange).toHaveBeenCalledWith(false));
    expect(window.location.pathname).toBe("/session");
  });
});
