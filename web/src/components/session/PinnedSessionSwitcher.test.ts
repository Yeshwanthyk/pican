import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import PinnedSessionSwitcher from "./PinnedSessionSwitcher.svelte";
import { normalizeSession } from "../../index/sessions";
import { PinnedTabsModel } from "../../session/pinned-tabs-model.svelte";
import { resetSessionPrefetch } from "../../routes/session-prefetch";

afterEach(() => {
  resetSessionPrefetch();
  vi.unstubAllGlobals();
});

describe("PinnedSessionSwitcher", () => {
  it("loads global pins and renders them in pin order", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/sessions?view=home") {
        return new Response(
          JSON.stringify({
            sessions: [
              {
                id: "first.jsonl",
                name: "First",
                project: "/repo/one",
                pinned: true,
                pinOrder: 3,
                runtime: "pi",
              },
              {
                id: "second.jsonl",
                name: "Second",
                project: "/repo/two",
                pinned: true,
                pinOrder: 1,
                runtime: "codex",
              },
              {
                id: "third.jsonl",
                name: "Third",
                project: "/repo/three",
                pinned: true,
                pinOrder: 2,
                runtime: "opencode",
              },
            ],
          }),
        );
      }
      return new Response(`unexpected request: ${url}`, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchImpl);

    const model = new PinnedTabsModel("first.jsonl");
    const { container } = render(PinnedSessionSwitcher, {
      props: {
        model,
        currentSession: normalizeSession({
          id: "first.jsonl",
          name: "First",
          project: "/repo/one",
          runtime: "pi",
        }),
      },
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
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/sessions?view=home",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("prefetches each legacy switch target on hover, mousedown, and touch without opening SSE", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ entries: [] })),
    );
    const EventSourceImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("EventSource", EventSourceImpl);

    const model = new PinnedTabsModel("current.jsonl");
    model.sessions = [
      normalizeSession({ id: "hover.jsonl", name: "Hover", project: "/repo", pinned: true }),
      normalizeSession({ id: "mouse.jsonl", name: "Mouse", project: "/repo", pinned: true }),
      normalizeSession({ id: "touch.jsonl", name: "Touch", project: "/repo", pinned: true }),
    ];
    const { container } = render(PinnedSessionSwitcher, {
      props: {
        model,
        currentSession: normalizeSession({
          id: "current.jsonl",
          name: "Current",
          project: "/repo",
        }),
      },
    });
    const rows = container.querySelectorAll<HTMLElement>(".pinned-session-switcher-row");

    await fireEvent.pointerEnter(rows[0]!);
    await fireEvent.mouseDown(rows[1]!);
    await fireEvent.touchStart(rows[2]!);

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/session?id=hover.jsonl&paginate=1",
      "/api/session?id=mouse.jsonl&paginate=1",
      "/api/session?id=touch.jsonl&paginate=1",
    ]);
    expect(EventSourceImpl).not.toHaveBeenCalled();
  });
});
