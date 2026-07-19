import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/svelte";
import CommandPalette from "./CommandPalette.svelte";
import { filterPaletteSessions, normalizePaletteSession } from "./command-palette";
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
    const session = normalizePaletteSession({ ID: "abc", Name: "Fix bug", Project: "/repo" });
    expect(session.href).toBe("/session?id=abc");
    expect(filterPaletteSessions([session], "fix")).toHaveLength(1);
    expect(filterPaletteSessions([session], "missing")).toHaveLength(0);
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
});
