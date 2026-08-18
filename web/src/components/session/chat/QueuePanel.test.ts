import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import QueuePanel from "./QueuePanel.svelte";
import { QueueStore } from "./queue-store.svelte";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("QueuePanel", () => {
  it("distinguishes server-queued work from a locally submitted steer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T14:05:00Z"));
    const store = new QueueStore();
    store.items = [
      {
        id: "q-1",
        kind: "queued",
        position: 1,
        text: "Do this next",
        displayText: "Do this next",
        createdAt: "2026-07-26T14:04:00Z",
      },
      {
        id: "q-2",
        kind: "queued",
        position: 2,
        text: "Then this",
        displayText: "Then this",
        createdAt: "2026-07-26T14:04:30Z",
      },
    ];
    store.pushSteer({ text: "Use the new constraint" });

    const { container } = render(QueuePanel, { props: { store } });
    const rows = container.querySelectorAll(".pi-queue-item");

    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("next up");
    expect(rows[0]).not.toHaveTextContent("queued #");
    expect(rows[0]?.querySelector("time")).toHaveAttribute("datetime", "2026-07-26T14:04:00Z");
    expect(rows[1]).toHaveTextContent("queued #2");
    expect(rows[1]?.querySelector("time")).toHaveAttribute("datetime", "2026-07-26T14:04:30Z");
    expect(rows[2]).toHaveTextContent("submitted");
    expect(rows[2]).not.toHaveTextContent("steered");
    expect(rows[2]?.querySelector("time")).toHaveAttribute("datetime", "2026-07-26T14:05:00.000Z");
  });

  it("shows a Send-now button on queued rows that calls store.actions.sendNow", async () => {
    const store = new QueueStore();
    store.items = [
      {
        id: "q-1",
        kind: "queued",
        position: 1,
        text: "Do this next",
        displayText: "Do this next",
        createdAt: "2026-07-26T14:04:00Z",
      },
      {
        id: "q-2",
        kind: "queued",
        position: 2,
        text: "Then this",
        displayText: "Then this",
        createdAt: "2026-07-26T14:04:30Z",
      },
    ];
    store.pushSteer({ text: "Use the new constraint" });
    const sendNow = vi.fn();
    store.actions.sendNow = sendNow;
    // Pre-set list focus so we can prove the button click doesn't move it.
    store.setFocusIndex(1);
    const { container } = render(QueuePanel, { props: { store } });
    const sendButtons = container.querySelectorAll(".pi-queue-item-send");

    // Only server-queued rows get a Send-now button; steer rows do not.
    expect(sendButtons).toHaveLength(2);
    await fireEvent.click(sendButtons[0]!);
    expect(sendNow).toHaveBeenCalledWith("q-1");
    await fireEvent.click(sendButtons[1]!);
    expect(sendNow).toHaveBeenCalledWith("q-2");
    // Clicking the button must not steal list focus onto the row itself.
    expect(store.focusIndex).toBe(1);
  });
});
