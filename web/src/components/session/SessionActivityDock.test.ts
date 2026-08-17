import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import SessionActivityDock from "./SessionActivityDock.svelte";

const runningSubagent = {
  id: "sa-001",
  title: "Fix the flaky dock test",
  harness: "pi",
  status: "running",
  spawnedAt: new Date(Date.now() - 60_000).toISOString(),
  parentSession: "parent.jsonl",
  parentProject: "/repo",
  childSession: "child.jsonl",
  childProject: "/repo",
  lastActivity: new Date().toISOString(),
};

const inProgressTask = {
  id: 7,
  subject: "Shave the yak",
  status: "in_progress",
  updatedAt: new Date().toISOString(),
};

const taskStore = {
  path: "/repo",
  scope: "session",
  sessionId: "parent.jsonl",
  tasks: [inProgressTask],
};

function jsonResponse(payload: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}

function stubFetch(subagents: unknown[], stores: unknown[]) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/subagents")) return jsonResponse({ subagents });
    if (url.startsWith("/api/tasks")) return jsonResponse({ stores });
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionActivityDock", () => {
  it("collapses to nothing when there are neither subagents nor tasks", async () => {
    const fetchImpl = stubFetch([], []);
    const { container } = render(SessionActivityDock, {
      props: { sessionId: "parent.jsonl", projectPath: "/repo" },
    });

    // Let both onMount fetches settle.
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const dock = container.querySelector("[data-session-activity-dock]");
    expect(dock).not.toBeNull();
    expect(dock).toHaveAttribute("hidden");
    expect(dock).not.toHaveTextContent("Agents");
    expect(dock).not.toHaveTextContent("Tasks");
  });

  it("shows Agents and Tasks sections with live data", async () => {
    stubFetch([runningSubagent], [taskStore]);
    const { container } = render(SessionActivityDock, {
      props: { sessionId: "parent.jsonl", projectPath: "/repo" },
    });

    const dock = container.querySelector("[data-session-activity-dock]");
    await waitFor(() => expect(dock).not.toHaveAttribute("hidden"));

    // Section headers.
    expect(dock).toHaveTextContent("Agents");
    expect(dock).toHaveTextContent("Tasks");

    // Agents: running count, agent row in a list item, transcript link.
    expect(dock).toHaveTextContent("1 running");
    expect(dock).toHaveTextContent("Fix the flaky dock test");

    const list = container.querySelector("[role='list']");
    expect(list).not.toBeNull();
    const row = container.querySelector(".session-dock-agent[role='listitem']");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("data-status", "running");
    const link = row?.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain("/session?");

    // Tasks: status chip label, subject.
    expect(dock).toHaveTextContent("in progress");
    expect(dock).toHaveTextContent("#7");
    expect(dock).toHaveTextContent("Shave the yak");
    expect(container.querySelector(".session-dock-task")).toHaveAttribute(
      "data-status",
      "in_progress",
    );

    // "open all" links target the subagents and tasks dashboards.
    const openAll = container.querySelectorAll(".session-dock-open-all");
    expect(openAll.length).toBe(2);
    expect(openAll[0]?.getAttribute("href")).toContain("/subagents?session=parent.jsonl");
    expect(openAll[1]?.getAttribute("href")).toContain(
      "/tasks?project=%2Frepo&session=parent.jsonl",
    );
  });

  it("shows only the Tasks section when there are no subagents", async () => {
    stubFetch([], [taskStore]);
    const { container } = render(SessionActivityDock, {
      props: { sessionId: "parent.jsonl", projectPath: "/repo" },
    });

    const dock = container.querySelector("[data-session-activity-dock]");
    await waitFor(() => expect(dock).not.toHaveAttribute("hidden"));

    expect(dock).toHaveTextContent("Tasks");
    expect(dock).toHaveTextContent("Shave the yak");
    expect(container.querySelector(".session-dock-agents-panel")).toBeNull();
    expect(dock).not.toHaveTextContent("Agents");
  });

  it("stays hidden for view-only sessions even with live data", async () => {
    stubFetch([runningSubagent], [taskStore]);
    const { container } = render(SessionActivityDock, {
      props: { sessionId: "parent.jsonl", projectPath: "/repo", chatAvailable: false },
    });

    const dock = container.querySelector("[data-session-activity-dock]");
    // Absorbs the fetch microtasks, then asserts the guard kicked in.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dock).toBeTruthy();
    expect(dock).toHaveAttribute("hidden");
  });
});
it("skips the tasks fetch when no project path is known", async () => {
  stubFetch([runningSubagent], [taskStore]);
  const { container } = render(SessionActivityDock, {
    props: { sessionId: "parent.jsonl", projectPath: "" },
  });

  const dock = container.querySelector("[data-session-activity-dock]");
  await waitFor(() => expect(dock).not.toHaveAttribute("hidden"));
  expect(dock).toHaveTextContent("Agents");
  expect(dock).not.toHaveTextContent("Tasks");
});

it("shows only running subagents in the live dock", async () => {
  const doneSubagent = {
    ...runningSubagent,
    id: "sa-002",
    title: "Green build",
    status: "done",
    lastActivity: new Date(Date.now() - 120_000).toISOString(),
  };
  const failedSubagent = {
    ...runningSubagent,
    id: "sa-003",
    title: "Broken deploy",
    status: "error",
  };
  stubFetch([runningSubagent, doneSubagent, failedSubagent], []);
  const { container } = render(SessionActivityDock, {
    props: { sessionId: "parent.jsonl", projectPath: "/repo" },
  });

  const dock = container.querySelector("[data-session-activity-dock]");
  await waitFor(() => expect(dock).not.toHaveAttribute("hidden"));

  // Settled agents belong to /subagents history, not the live activity dock.
  expect(container.querySelectorAll('[data-count="running"]').length).toBe(1);
  expect(dock).toHaveTextContent("1 running");
  expect(dock).not.toHaveTextContent("Green build");
  expect(dock).not.toHaveTextContent("Broken deploy");
  expect(dock).not.toHaveTextContent("done");
  expect(dock).not.toHaveTextContent("failed");
});

it("bounds the live agent list and exposes overflow", async () => {
  const subagents = Array.from({ length: 5 }, (_, index) => ({
    ...runningSubagent,
    id: `sa-${index}`,
    title: `Running agent ${index}`,
  }));
  stubFetch(subagents, []);
  const { container } = render(SessionActivityDock, {
    props: { sessionId: "parent.jsonl", projectPath: "/repo" },
  });

  const dock = container.querySelector("[data-session-activity-dock]");
  await waitFor(() => expect(dock).not.toHaveAttribute("hidden"));

  expect(container.querySelectorAll(".session-dock-agent")).toHaveLength(4);
  expect(dock).toHaveTextContent("5 running");
  expect(dock).toHaveTextContent("+1 more");
});
