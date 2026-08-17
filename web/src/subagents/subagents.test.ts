import { describe, expect, it } from "vitest";
import {
  normalizeSubagent,
  orderSubagents,
  parentSessionParam,
  subagentActivityTime,
  subagentProject,
  subagentTranscriptHref,
} from "./subagents";

describe("subagent helpers", () => {
  it("normalizes optional fields and unsupported statuses", () => {
    expect(normalizeSubagent({ id: "sa-1", title: "Review", status: "finished" })).toEqual({
      id: "sa-1",
      title: "Review",
      harness: "",
      status: "unknown",
      spawnedAt: "",
      parentSession: "",
      parentProject: "",
      childSession: "",
      childProject: "",
      lastActivity: "",
    });
  });

  it("prefers last activity and the child project", () => {
    const subagent = {
      spawnedAt: "2026-07-17T10:00:00Z",
      lastActivity: "2026-07-17T10:01:00Z",
      parentProject: "/repo/parent",
      childProject: "/repo/child",
    };
    expect(subagentActivityTime(subagent)).toBe("2026-07-17T10:01:00Z");
    expect(subagentProject(subagent)).toBe("/repo/child");
  });

  it("falls back to spawn time and parent project", () => {
    const subagent = { spawnedAt: "2026-07-17T10:00:00Z", parentProject: "/repo" };
    expect(subagentActivityTime(subagent)).toBe("2026-07-17T10:00:00Z");
    expect(subagentProject(subagent)).toBe("/repo");
  });

  it("builds the child transcript href with the parent param", () => {
    expect(
      subagentTranscriptHref({
        childSession: "child.jsonl",
        parentSession: "parent.jsonl",
      }),
    ).toBe("/session?id=child.jsonl&parent=parent.jsonl");
  });

  it("omits the parent param without a recorded parent", () => {
    expect(subagentTranscriptHref({ childSession: "child.jsonl" })).toBe("/session?id=child.jsonl");
  });

  it("falls back to the parent session href without a child", () => {
    expect(subagentTranscriptHref({ parentSession: "parent.jsonl" })).toBe(
      "/session?id=parent.jsonl",
    );
  });

  it("returns an empty href when neither session is recorded", () => {
    expect(subagentTranscriptHref({})).toBe("");
  });

  it("parses the parent session param out of a search string", () => {
    expect(parentSessionParam("?id=child.jsonl&parent=parent.jsonl")).toBe("parent.jsonl");
    expect(parentSessionParam("?id=child.jsonl")).toBe("");
    expect(parentSessionParam("")).toBe("");
    expect(parentSessionParam("?parent=https%3A%2F%2Fexample.com%2Fx")).toBe(
      "https://example.com/x",
    );
  });
});

describe("orderSubagents", () => {
  it("sorts running agents first, then errors, then done, then unknown", () => {
    const subs = [
      normalizeSubagent({ id: "done", status: "done", lastActivity: "2026-07-17T12:00:00Z" }),
      normalizeSubagent({ id: "unknown", status: "unknown" }),
      normalizeSubagent({ id: "error", status: "error", lastActivity: "2026-07-17T12:01:00Z" }),
      normalizeSubagent({
        id: "running-2",
        status: "running",
        lastActivity: "2026-07-17T12:02:00Z",
      }),
      normalizeSubagent({
        id: "running-1",
        status: "running",
        lastActivity: "2026-07-17T12:03:00Z",
      }),
    ];
    expect(orderSubagents(subs).map((s) => s.id)).toEqual([
      "running-1",
      "running-2",
      "error",
      "done",
      "unknown",
    ]);
  });

  it("orders by most recent activity within a status group", () => {
    const subs = [
      normalizeSubagent({ id: "old", status: "done", lastActivity: "2026-07-17T10:00:00Z" }),
      normalizeSubagent({ id: "middle", status: "done", spawnedAt: "2026-07-17T10:15:00Z" }),
      normalizeSubagent({ id: "recent", status: "done", lastActivity: "2026-07-17T10:30:00Z" }),
    ];
    expect(orderSubagents(subs).map((s) => s.id)).toEqual(["recent", "middle", "old"]);
  });

  it("keeps unknown last even when most recently active", () => {
    const subs = [
      normalizeSubagent({ id: "unknown", status: "unknown", lastActivity: "2026-07-17T12:00:00Z" }),
      normalizeSubagent({ id: "done", status: "done", lastActivity: "2026-07-17T11:00:00Z" }),
    ];
    expect(orderSubagents(subs).map((s) => s.id)).toEqual(["done", "unknown"]);
  });

  it("keeps relative order stable when activity times tie", () => {
    const subs = [
      normalizeSubagent({ id: "first", status: "done" }),
      normalizeSubagent({ id: "second", status: "done" }),
    ];
    expect(orderSubagents(subs).map((s) => s.id)).toEqual(["first", "second"]);
  });

  it("returns a new array and never mutates the input", () => {
    const subs = [
      normalizeSubagent({ id: "a", status: "unknown", lastActivity: "2026-07-17T10:00:00Z" }),
      normalizeSubagent({ id: "b", status: "running", lastActivity: "2026-07-17T09:00:00Z" }),
    ];
    const before = subs.map((s) => ({ ...s }));
    const result = orderSubagents(subs);
    expect(result).not.toBe(subs);
    expect(subs).toEqual(before);
  });

  it("returns an empty array for empty input", () => {
    expect(orderSubagents([])).toEqual([]);
    expect(orderSubagents([])).not.toBe([]);
  });
});
