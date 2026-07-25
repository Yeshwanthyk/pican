import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import PinnedSessionSwitcher from "./PinnedSessionSwitcher.svelte";

afterEach(() => vi.unstubAllGlobals());

describe("PinnedSessionSwitcher", () => {
  it("loads global pins and renders them in pin order", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/pins") {
        return new Response(
          JSON.stringify({ pins: ["second.jsonl", "third.jsonl", "first.jsonl"] }),
        );
      }
      if (url === "/api/sessions?limit=1&view=all") {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "first.jsonl",
                name: "First",
                project: "/repo/one",
                pinned: true,
                runtime: "pi",
              },
              {
                id: "second.jsonl",
                name: "Second",
                project: "/repo/two",
                pinned: true,
                runtime: "codex",
              },
              {
                id: "third.jsonl",
                name: "Third",
                project: "/repo/three",
                pinned: true,
                runtime: "opencode",
              },
            ],
          }),
        );
      }
      return new Response(`unexpected request: ${url}`, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { container } = render(PinnedSessionSwitcher, {
      props: { sessionId: "first.jsonl" },
    });
    const switcher = container.querySelector("#pinned-session-switcher");
    const toggle = new Event("toggle");
    Object.defineProperty(toggle, "newState", { value: "open" });
    switcher?.dispatchEvent(toggle);

    await waitFor(() => {
      expect(container.querySelectorAll(".pinned-session-switcher-row")).toHaveLength(3);
    });
    const titles = Array.from(
      container.querySelectorAll(".pinned-session-switcher-title"),
      (node) => node.textContent,
    );
    expect(titles).toEqual(["Second", "Third", "First"]);
    expect(
      Array.from(
        container.querySelectorAll<HTMLImageElement>(".pinned-session-switcher-runtime-mark"),
        (mark) => mark.getAttribute("src"),
      ),
    ).toEqual(["/codex-icon.svg", null, "/pi-icon.svg"]);
    expect(container.querySelector('[title="OpenCode"]')).toHaveTextContent("O");
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent("First");
  });
});
