import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { normalizeSession } from "../../index/sessions";
import { PinnedTabsModel } from "../../session/pinned-tabs-model.svelte";
import PinnedTabsStrip from "./PinnedTabsStrip.svelte";
import { resetSessionPrefetch } from "../../routes/session-prefetch";

afterEach(() => {
  resetSessionPrefetch();
  vi.unstubAllGlobals();
});

const pinned = (id: string, pinOrder: number, runtime = "pi") =>
  normalizeSession({
    id,
    name: `Session ${id}`,
    project: "/repo",
    pinned: true,
    pinOrder,
    runtime,
  });

describe("PinnedTabsStrip", () => {
  it("caps the strip at eight sessions while retaining the current pin", () => {
    const model = new PinnedTabsModel("s10");
    model.sessions = Array.from({ length: 10 }, (_, index) => pinned(`s${index + 1}`, index + 1));

    const { container } = render(PinnedTabsStrip, {
      props: {
        model,
        currentSession: model.sessions[9]!,
      },
    });

    const tabs = Array.from(container.querySelectorAll<HTMLElement>(".pinned-tab"));
    expect(tabs).toHaveLength(8);
    expect(tabs.map((tab) => tab.dataset.sessionId)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
      "s10",
    ]);
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent("Session s10");
  });

  it("does not prefetch the active tab when it mounts under the pointer", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ entries: [] })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const model = new PinnedTabsModel("current");
    model.sessions = [pinned("current", 1), pinned("other", 2)];
    const { container } = render(PinnedTabsStrip, {
      props: { model, currentSession: model.sessions[0]! },
    });

    const current = container.querySelector<HTMLElement>('[data-session-id="current"] a');
    const other = container.querySelector<HTMLElement>('[data-session-id="other"] a');
    await fireEvent.pointerEnter(current!);
    expect(fetchImpl).not.toHaveBeenCalled();

    await fireEvent.pointerEnter(other!);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("id=other");
  });

  it("counts the guest against capacity and renders all runtime marks", () => {
    const model = new PinnedTabsModel("guest");
    model.sessions = Array.from({ length: 8 }, (_, index) =>
      pinned(`s${index + 1}`, index + 1, index === 1 ? "opencode" : "pi"),
    );
    const guest = normalizeSession({
      id: "guest",
      name: "Guest",
      project: "/repo",
      runtime: "claude",
    });

    const { container } = render(PinnedTabsStrip, {
      props: { model, currentSession: guest },
    });

    expect(container.querySelectorAll(".pinned-tab")).toHaveLength(8);
    expect(container.querySelector(".pinned-tab--guest")).toHaveTextContent("Guest");
    expect(container.querySelector('[aria-label="Pin session"]')).not.toBeNull();
    expect(container.querySelector('[title="OpenCode"]')).toHaveTextContent("O");
    expect(
      container.querySelector<HTMLImageElement>(".pinned-tab--guest .pinned-tab-runtime")?.src,
    ).toContain("/claude-icon.svg");
  });
});
