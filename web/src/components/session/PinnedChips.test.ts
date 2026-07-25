import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import { normalizeSession } from "../../index/sessions";
import { PinnedTabsModel } from "../../session/pinned-tabs-model.svelte";
import PinnedChips from "./PinnedChips.svelte";

let observedWidth = 320;

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: { width: observedWidth } as DOMRectReadOnly,
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}

const pinned = (id: string, pinOrder: number) =>
  normalizeSession({
    id,
    name: `Session ${id}`,
    project: "/repo",
    pinned: true,
    pinOrder,
    runtime: pinOrder === 2 ? "opencode" : "pi",
    lastActivity: "2026-07-25T00:00:00Z",
  });

afterEach(() => vi.unstubAllGlobals());

describe("PinnedChips", () => {
  it.each([
    [320, 5],
    [390, 6],
  ])("fits the active chip and bounded idle chips at %ipx", async (width, expected) => {
    observedWidth = width;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const model = new PinnedTabsModel("s10");
    model.sessions = Array.from({ length: 10 }, (_, index) => pinned(`s${index + 1}`, index + 1));

    const { container } = render(PinnedChips, {
      props: {
        model,
        currentSession: model.sessions[9]!,
        currentRunning: true,
      },
    });

    await waitFor(() => {
      expect(container.querySelectorAll(".pinned-chip")).toHaveLength(expected);
    });
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent("Session s10");
    expect(container.querySelector('[aria-current="page"]')).toHaveTextContent("working");
    expect(container.querySelector('[title="OpenCode"]')).toHaveTextContent("O");
  });

  it("uses a capacity slot for the guest and exposes an explicit Pin action", async () => {
    observedWidth = 320;
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const model = new PinnedTabsModel("guest");
    model.sessions = Array.from({ length: 8 }, (_, index) => pinned(`s${index + 1}`, index + 1));
    const guest = normalizeSession({
      id: "guest",
      name: "Guest",
      project: "/repo",
      runtime: "claude",
      waitingQuestion: "Approve?",
    });

    const { container } = render(PinnedChips, {
      props: {
        model,
        currentSession: guest,
        currentWaiting: true,
      },
    });

    await waitFor(() => {
      expect(container.querySelectorAll(".pinned-chip")).toHaveLength(5);
    });
    expect(container.querySelector(".pinned-chip--guest")).toHaveTextContent("awaiting you");
    expect(container.querySelector('[aria-label="Pin session"]')).not.toBeNull();
  });
});
