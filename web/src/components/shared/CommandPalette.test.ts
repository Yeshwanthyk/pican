import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/svelte";
import CommandPalette from "./CommandPalette.svelte";
import {
  fetchPaletteSessions,
  filterPaletteSessions,
  normalizePaletteSession,
  prioritizePinnedPaletteSessions,
} from "./command-palette";
import {
  getSessionPaletteApi,
  openSessionPalette,
  setSessionPaletteApi,
} from "../../shared/command-palette-runtime";

afterEach(() => {
  cleanup();
  setSessionPaletteApi(null);
  delete window.__piOpenSessionPalette;
  delete window.__piSessionPalette;
});

describe("CommandPalette", () => {
  it("normalizes and filters sessions", () => {
    const session = normalizePaletteSession({
      ID: "abc",
      Name: "Fix bug",
      Project: "/repo",
      Pinned: true,
      PinOrder: 2,
    });
    expect(session.href).toBe("/session?id=abc");
    expect(session).toMatchObject({ pinned: true, pinOrder: 2 });
    expect(filterPaletteSessions([session], "fix")).toHaveLength(1);
    expect(filterPaletteSessions([session], "missing")).toHaveLength(0);
  });

  it("prioritizes pinned sessions in pin order without reordering other sessions", () => {
    const sessions = [
      normalizePaletteSession({ id: "recent", name: "Recent" }),
      normalizePaletteSession({ id: "pin-2", name: "Second pin", pinned: true, pinOrder: 2 }),
      normalizePaletteSession({ id: "older", name: "Older" }),
      normalizePaletteSession({ id: "pin-1", name: "First pin", pinned: true, pinOrder: 1 }),
    ];

    expect(prioritizePinnedPaletteSessions(sessions).map(({ id }) => id)).toEqual([
      "pin-1",
      "pin-2",
      "recent",
      "older",
    ]);
  });

  it("opens through the window bridge and navigates a selected session", async () => {
    const seen: string[] = [];
    render(CommandPalette, {
      props: {
        loadSessions: async () => [{ id: "s1", name: "Session one", model: "m" }],
        navigate: (url: string) => seen.push(url),
      },
    });
    await window.__piOpenSessionPalette?.();
    await screen.findByText("Session one");
    await fireEvent.click(screen.getByText("Session one"));
    expect(seen).toEqual(["/session?id=s1"]);
  });

  it("renders pinned sessions before recent unpinned sessions", async () => {
    const { container } = render(CommandPalette, {
      props: {
        loadSessions: async () => [
          { id: "recent", name: "Recent" },
          { id: "pinned", name: "Pinned", pinned: true, pinOrder: 1 },
        ],
      },
    });
    await openSessionPalette();
    await screen.findByText("Pinned");

    expect(
      Array.from(container.querySelectorAll(".palette-result-title"), (node) => node.textContent),
    ).toEqual(["Pinned", "Recent"]);
  });

  it("registers the explicit session palette runtime API", async () => {
    render(CommandPalette, {
      props: {
        loadSessions: async () => [{ id: "s1", name: "Session one", model: "m" }],
      },
    });
    expect(getSessionPaletteApi()).toBeTruthy();
    await openSessionPalette();
    expect(await screen.findByText("Session one")).toBeTruthy();
  });

  it("renders the plain search-empty state and Escape clears the query", async () => {
    const onQueryChange = vi.fn();
    render(CommandPalette, {
      props: { loadSessions: async () => [], onQueryChange },
    });
    await openSessionPalette();
    const input = screen.getByPlaceholderText("Search sessions...");
    await fireEvent.input(input, { target: { value: "missing" } });
    expect(await screen.findByText('no matches for "missing"')).toBeInTheDocument();
    expect(screen.getByText("esc clears the search")).toBeInTheDocument();

    await fireEvent.keyDown(window, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(onQueryChange).toHaveBeenLastCalledWith("");
  });

  it("uses focused home for an empty query and global all for typed search", async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ sessions: [], total: 0 }));
    };

    await fetchPaletteSessions({ fetchImpl, query: "" });
    await fetchPaletteSessions({ fetchImpl, query: " needle " });

    expect(urls).toEqual([
      "/api/sessions?view=home&limit=50",
      "/api/sessions?view=all&q=needle&limit=50",
    ]);
    expect(urls.every((url) => !url.includes("project="))).toBe(true);
  });

  it("keeps typed search inside the explicit archived view", async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ sessions: [], total: 0 }));
    };

    await fetchPaletteSessions({ fetchImpl, query: "old", view: "archived" });

    expect(urls).toEqual(["/api/sessions?view=archived&q=old&limit=50"]);
  });
});
