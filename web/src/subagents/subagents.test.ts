import { describe, expect, it } from "vitest";
import { normalizeSubagent, subagentActivityTime, subagentProject } from "./subagents";

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
});
