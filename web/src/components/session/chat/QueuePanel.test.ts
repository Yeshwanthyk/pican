import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
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
    ];
    store.pushSteer({ text: "Use the new constraint" });

    const { container } = render(QueuePanel, { props: { store } });
    const rows = container.querySelectorAll(".pi-queue-item");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("queued next");
    expect(rows[0]?.querySelector("time")).toHaveAttribute("datetime", "2026-07-26T14:04:00Z");
    expect(rows[1]).toHaveTextContent("submitted");
    expect(rows[1]).not.toHaveTextContent("steered");
    expect(rows[1]?.querySelector("time")).toHaveAttribute("datetime", "2026-07-26T14:05:00.000Z");
  });
});
