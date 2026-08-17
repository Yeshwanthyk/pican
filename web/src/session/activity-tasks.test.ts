import { describe, expect, it } from "vitest";
import type { Task, TaskList } from "../lib/schema";
import { flattenDockTasks, taskStatusLabelKey } from "./activity-tasks";

function listFor(stores: Array<{ tasks: Task[] }>): TaskList {
  return {
    stores: stores.map((store, index) => ({
      path: `store-${index}`,
      scope: "session",
      sessionId: `session-${index}`,
      tasks: store.tasks,
    })),
  };
}

describe("flattenDockTasks", () => {
  it("flattens every store's tasks into dock rows", () => {
    const list = listFor([
      {
        tasks: [
          { id: "t1", subject: "Alpha", status: "pending", updatedAt: "2026-07-17T10:00:00Z" },
        ],
      },
      {
        tasks: [
          { id: "t2", subject: "Beta", status: "completed", updatedAt: "2026-07-17T10:01:00Z" },
        ],
      },
    ]);
    expect(flattenDockTasks(list)).toEqual([
      { id: "t1", subject: "Alpha", status: "pending", updatedAt: "2026-07-17T10:00:00Z" },
      { id: "t2", subject: "Beta", status: "completed", updatedAt: "2026-07-17T10:01:00Z" },
    ]);
  });

  it("dedupes by id keeping the latest status per id", () => {
    const list = listFor([
      {
        tasks: [
          { id: "t1", subject: "Alpha", status: "pending", updatedAt: "2026-07-17T10:00:00Z" },
          { id: "t1", subject: "Alpha", status: "in_progress", updatedAt: "2026-07-17T10:02:00Z" },
        ],
      },
    ]);
    const result = flattenDockTasks(list);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("in_progress");
  });

  it("prefers the later updatedAt even from an earlier array position", () => {
    const list = listFor([
      {
        tasks: [
          { id: "t1", status: "pending", updatedAt: "2026-07-17T10:05:00Z" },
          { id: "t1", status: "completed", updatedAt: "2026-07-17T10:01:00Z" },
        ],
      },
    ]);
    expect(flattenDockTasks(list)).toEqual([
      { id: "t1", subject: "", status: "pending", updatedAt: "2026-07-17T10:05:00Z" },
    ]);
  });

  it("breaks updatedAt ties by the later array position", () => {
    const list = listFor([
      {
        tasks: [
          { id: "t1", status: "pending", updatedAt: "2026-07-17T10:00:00Z" },
          { id: "t1", status: "completed", updatedAt: "2026-07-17T10:00:00Z" },
        ],
      },
    ]);
    expect(flattenDockTasks(list)[0]!.status).toBe("completed");
  });

  it("dedupes across stores, not only within one store", () => {
    const list = listFor([
      { tasks: [{ id: "t1", status: "pending", updatedAt: "2026-07-17T10:00:00Z" }] },
      { tasks: [{ id: "t1", status: "failed", updatedAt: "2026-07-17T10:03:00Z" }] },
    ]);
    expect(flattenDockTasks(list)).toEqual([
      { id: "t1", subject: "", status: "failed", updatedAt: "2026-07-17T10:03:00Z" },
    ]);
  });

  it("turns missing or unknown fields into plain strings", () => {
    const list = listFor([{ tasks: [{ subject: "Bare" }] }]);
    expect(flattenDockTasks(list)).toEqual([
      { id: "", subject: "Bare", status: "unknown", updatedAt: "" },
    ]);
    const numeric = listFor([{ tasks: [{ id: 42, subject: "Numeric", status: "done" }] }]);
    expect(flattenDockTasks(numeric)[0]!.id).toBe("42");
  });

  it("ranks in_progress first, then failed, pending, completed, and other", () => {
    const list = listFor([
      {
        tasks: [
          { id: "c1", subject: "Zed", status: "completed", updatedAt: "2026-07-17T10:09:00Z" },
          { id: "p1", subject: "Alpha", status: "pending", updatedAt: "2026-07-17T10:08:00Z" },
          { id: "i1", subject: "Beta", status: "in_progress", updatedAt: "2026-07-17T10:07:00Z" },
          { id: "f1", subject: "Gamma", status: "failed", updatedAt: "2026-07-17T10:06:00Z" },
          { id: "x1", subject: "Delta", status: "queued", updatedAt: "2026-07-17T10:05:00Z" },
        ],
      },
    ]);
    expect(flattenDockTasks(list).map((t) => t.id)).toEqual(["i1", "f1", "p1", "c1", "x1"]);
  });

  it("sorts by most recent updatedAt within a status group, subject as tiebreak", () => {
    const list = listFor([
      {
        tasks: [
          { id: "t2", subject: "Gamma", status: "done", updatedAt: "2026-07-17T10:02:00Z" },
          { id: "t1", subject: "Beta", status: "done", updatedAt: "2026-07-17T10:03:00Z" },
          { id: "t3", subject: "Alpha", status: "done", updatedAt: "2026-07-17T10:03:00Z" },
        ],
      },
    ]);
    // t1 and t3 tie on updatedAt → subject asc: Alpha (t3) before Beta (t1).
    expect(flattenDockTasks(list).map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
  });

  it("returns an empty array for an empty payload", () => {
    expect(flattenDockTasks({ stores: [] })).toEqual([]);
  });
});

describe("taskStatusLabelKey", () => {
  it("maps the known task statuses to session.* keys", () => {
    expect(taskStatusLabelKey("in_progress")).toBe("session.inProgress");
    expect(taskStatusLabelKey("completed")).toBe("session.completed");
    expect(taskStatusLabelKey("pending")).toBe("session.pending");
    expect(taskStatusLabelKey("failed")).toBe("session.failed");
  });

  it("returns an empty key for unknown statuses so the raw text is shown", () => {
    expect(taskStatusLabelKey("queued")).toBe("");
    expect(taskStatusLabelKey("")).toBe("");
  });
});
