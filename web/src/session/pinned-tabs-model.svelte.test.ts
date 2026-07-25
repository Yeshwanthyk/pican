import { describe, expect, it, vi } from "vitest";
import type { StatusEventsOptions } from "../shared/status-events";
import { normalizeSession } from "../index/sessions";
import {
  PinnedTabsModel,
  pinnedSessionsFromCatalog,
  selectVisiblePinnedSessions,
} from "./pinned-tabs-model.svelte";

const raw = (
  id: string,
  {
    pinned = true,
    pinOrder = 1,
    archived = false,
  }: { pinned?: boolean; pinOrder?: number; archived?: boolean } = {},
) => ({ id, name: id, project: "/repo", pinned, pinOrder, archived });

describe("PinnedTabsModel", () => {
  it("builds a canonical, ordered pinned list and drops archived or unpinned sessions", () => {
    expect(
      pinnedSessionsFromCatalog([
        raw("third", { pinOrder: 3 }),
        raw("archived", { pinOrder: 1, archived: true }),
        raw("first", { pinOrder: 1 }),
        raw("unrelated", { pinned: false }),
        raw("second", { pinOrder: 2 }),
      ]).map((session) => session.id),
    ).toEqual(["first", "second", "third"]);
  });

  it("keeps the current pinned session visible inside a bounded strip", () => {
    const sessions = Array.from({ length: 10 }, (_, index) =>
      normalizeSession(raw(`s${index + 1}`, { pinOrder: index + 1 })),
    );
    expect(selectVisiblePinnedSessions(sessions, "s10", 8).map((session) => session.id)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
      "s10",
    ]);
  });

  it("does not connect the global status stream until tabs are enabled", async () => {
    let statusOptions: StatusEventsOptions | undefined;
    const connect = vi.fn();
    const cleanup = vi.fn();
    const fetchHome = vi.fn(async () => ({ sessions: [raw("a"), raw("b", { pinOrder: 2 })] }));
    const model = new PinnedTabsModel("a", {
      fetchHome,
      createEvents: (options) => {
        statusOptions = options;
        return { connect, cleanup };
      },
    });

    expect(connect).not.toHaveBeenCalled();
    model.setEnabled(true);
    await model.load();
    expect(connect).toHaveBeenCalledOnce();
    expect(model.sessions.map((session) => session.id)).toEqual(["a", "b"]);

    statusOptions?.onSnapshot?.({ ids: ["b"], statuses: {} });
    expect(model.isRunning("b")).toBe(true);
    statusOptions?.onDelta?.({
      id: "b",
      running: false,
      model: "",
      modelName: "",
      modelProvider: "",
    });
    expect(model.isRunning("b")).toBe(false);

    model.setEnabled(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rolls an optimistic pin back when persistence fails", async () => {
    const updatePin = vi.fn(async () => {
      throw new Error("offline");
    });
    const model = new PinnedTabsModel("guest", {
      fetchHome: async () => ({ sessions: [] }),
      updatePin,
    });
    const guest = normalizeSession(raw("guest", { pinned: false, archived: true }));

    const pending = model.setPinned(guest, true);
    expect(model.isPinned("guest")).toBe(true);
    expect(await pending).toBe(false);
    expect(model.isPinned("guest")).toBe(false);
    expect(updatePin).toHaveBeenCalledWith("guest", true);
  });
});
