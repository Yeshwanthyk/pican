import { describe, expect, it, vi } from "vitest";
import {
  dateBucketFor,
  defaultCreateSession,
  formatRelativeTime,
  formatElapsed,
  formatSessionMetrics,
  groupSessionsByDate,
  groupSessionsByProject,
  groupTrackedProjectSessions,
  normalizeRuntimesResponse,
  normalizeSession,
  sessionModelLabel,
  sessionSearchText,
  stabilizeHomeSessionOrder,
  splitPinnedSessions,
  shouldRefetchOnReload,
  sessionsURL,
} from "./sessions.js";

describe("index sessions helpers", () => {
  it("normalizes Go and JS-shaped sessions", () => {
    expect(
      normalizeSession({ ID: "a", Project: "/repo", ModelProvider: "p", Model: "m" }),
    ).toMatchObject({
      id: "a",
      project: "/repo",
      modelProvider: "p",
      model: "m",
      runtime: "pi",
      nativeId: "",
      chatAvailable: true,
      pinned: false,
      pinOrder: 0,
      currentActivity: "",
      waitingQuestion: "",
    });
    expect(normalizeSession({ id: "a", pinned: true })).toMatchObject({ pinned: true });
    expect(normalizeSession({ ID: "a", Pinned: true })).toMatchObject({ pinned: true });
    expect(normalizeSession({ ID: "c", Runtime: "CODEX", NativeID: "thread-1" })).toMatchObject({
      runtime: "codex",
      nativeId: "thread-1",
    });
  });

  it("normalizes runtime responses and selects an available default", () => {
    const normalized = normalizeRuntimesResponse({
      defaultRuntime: "codex",
      runtimes: [
        { id: "pi", available: false, reason: "pi missing" },
        { id: "codex", available: true },
      ],
    });
    expect(normalized).toMatchObject({
      defaultRuntime: "codex",
      selectedRuntime: "codex",
      runtimes: [
        { id: "pi", label: "Pi", available: false, reason: "pi missing" },
        { id: "codex", label: "Codex", available: true, reason: "" },
      ],
    });
    expect(normalized.runtimes[0]?.capabilities.chat).toBe(true);
    expect(normalizeRuntimesResponse()).toMatchObject({
      defaultRuntime: "pi",
      selectedRuntime: "pi",
      runtimes: [{ id: "pi", label: "Pi", available: true, reason: "" }],
    });
  });

  it("preserves open runtime descriptors and normalizes explicit capabilities", () => {
    const normalized = normalizeRuntimesResponse({
      defaultRuntime: "custom-runtime",
      runtimes: [
        {
          id: "CUSTOM-RUNTIME",
          label: "Custom Runtime",
          available: true,
          projectionMode: "replaceable-projection",
          capabilities: { create: true, chat: false, files: true, userQuestions: false },
        },
      ],
    });

    expect(normalized).toMatchObject({
      defaultRuntime: "custom-runtime",
      selectedRuntime: "custom-runtime",
      runtimes: [
        {
          id: "custom-runtime",
          label: "Custom Runtime",
          projectionMode: "replaceable-projection",
          capabilities: { create: true, chat: false, files: true, userQuestions: false },
        },
      ],
    });
    expect(Object.keys(normalized.runtimes[0]?.capabilities ?? {})).toHaveLength(22);
  });

  it("does not select an available runtime that cannot create sessions", () => {
    const normalized = normalizeRuntimesResponse({
      defaultRuntime: "future",
      runtimes: [
        { id: "future", available: true, capabilities: { chat: true, create: false } },
        { id: "pi", available: true },
      ],
    });
    expect(normalized.selectedRuntime).toBe("pi");
  });

  it("includes the selected runtime when creating a session", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: "new" })));
    await defaultCreateSession("/repo", "codex", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("/api/new-session", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": expect.any(String),
      },
      body: JSON.stringify({ path: "/repo", runtime: "codex" }),
      signal: expect.any(AbortSignal),
    });
  });

  it("retains a create intent key across a failed retry and rotates it after success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "retry" }), { status: 503 }))
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true, id: "new" }))),
      );

    await expect(defaultCreateSession("/retry-repo", "codex", { fetchImpl })).rejects.toBeDefined();
    await defaultCreateSession("/retry-repo", "codex", { fetchImpl });
    await defaultCreateSession("/retry-repo", "codex", { fetchImpl });

    const key = (call: number): string => {
      const init = fetchImpl.mock.calls[call]?.[1] as RequestInit;
      return (init.headers as Record<string, string>)["Idempotency-Key"] ?? "";
    };
    expect(key(0)).toBe(key(1));
    expect(key(2)).not.toBe(key(1));
  });

  it("formats relative times", () => {
    expect(formatRelativeTime("2024-01-01T00:00:00Z", Date.parse("2024-01-01T00:02:00Z"))).toBe(
      "2 minutes ago",
    );
    expect(formatRelativeTime("not a date")).toBe("");
  });

  it("formats compact elapsed durations", () => {
    const now = Date.parse("2024-01-01T01:00:00Z");
    expect(formatElapsed("2024-01-01T00:59:42Z", now)).toBe("18s");
    expect(formatElapsed("2024-01-01T00:42:00Z", now)).toBe("18m");
    expect(formatElapsed("2023-12-31T23:00:00Z", now)).toBe("2h");
  });

  it("builds labels and search text", () => {
    const session = {
      name: "Fix bug",
      project: "/repo",
      modelProvider: "openai",
      model: "gpt",
      sessionUUID: "uuid",
      runtime: "codex",
      nativeId: "thread-1",
    };
    expect(sessionModelLabel(session)).toBe("openai/gpt");
    expect(sessionSearchText(session)).toContain("Fix bug /repo openai/gpt uuid codex thread-1");
  });

  it("groups project layout by latest activity", () => {
    const groups = groupSessionsByProject([
      { id: "old", project: "a", lastActivity: "2024-01-01T00:00:00Z" },
      { id: "new", project: "b", lastActivity: "2024-01-03T00:00:00Z" },
      { id: "mid", project: "a", lastActivity: "2024-01-02T00:00:00Z" },
    ]);
    expect(groups.map((g) => g.project)).toEqual(["b", "a"]);
    expect(groups[1]?.sessions.map((s) => s.id)).toEqual(["mid", "old"]);
  });

  it("keeps one group per project even when sessions are interleaved in time", () => {
    const groups = groupSessionsByProject([
      { id: "1", project: "a", lastActivity: "2024-01-03T00:00:00Z" },
      { id: "2", project: "b", lastActivity: "2024-01-02T00:00:00Z" },
      { id: "3", project: "a", lastActivity: "2024-01-01T00:00:00Z" },
    ]);
    expect(groups.map((g) => g.project)).toEqual(["a", "b"]);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["1", "3"]);
  });

  it("builds bounded groups for every explicitly tracked project", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => ({
      id: `a-${index}`,
      project: "/a",
      lastActivity: new Date(Date.UTC(2026, 6, 24, 12, index)).toISOString(),
    }));
    const groups = groupTrackedProjectSessions(sessions, [
      { path: "/a", tracked: true, sessionCount: 80 },
      { path: "/quiet", tracked: true, sessionCount: 0 },
      { path: "/hidden", tracked: false, sessionCount: 5 },
    ]);

    expect(groups.map((group) => group.project)).toEqual(["/a", "/quiet"]);
    expect(groups[0]?.sessions).toHaveLength(6);
    expect(groups[0]?.total).toBe(80);
    expect(groups[1]?.sessions).toEqual([]);
  });

  it("keeps tracked project and session order stable while activity timestamps change", () => {
    const projects = [
      { path: "/a", tracked: true, sessionCount: 2 },
      { path: "/b", tracked: true, sessionCount: 1 },
    ];
    const groups = groupTrackedProjectSessions(
      [
        { id: "a-old", project: "/a", lastActivity: "2024-01-01T00:00:00Z" },
        { id: "a-new", project: "/a", lastActivity: "2024-01-03T00:00:00Z" },
        { id: "b", project: "/b", lastActivity: "2024-01-04T00:00:00Z" },
      ],
      projects,
    );

    expect(groups.map((group) => group.project)).toEqual(["/a", "/b"]);
    expect(groups[0]?.sessions.map((session) => session.id)).toEqual(["a-old", "a-new"]);
  });

  it("builds explicit scoped session URLs with project precedence", () => {
    expect(sessionsURL({ view: "home" })).toBe("/api/sessions?view=home");
    expect(sessionsURL({ view: "all", limit: 100, offset: 100 })).toBe(
      "/api/sessions?limit=100&offset=100&view=all",
    );
    expect(sessionsURL({ view: "archived", project: "/repo with space" })).toBe(
      "/api/sessions?project=%2Frepo+with+space",
    );
  });

  it("buckets timestamps by recency relative to now", () => {
    const now = Date.parse("2024-03-15T12:00:00Z");
    const day = 86400000;
    expect(dateBucketFor(now, now)).toBe("today");
    expect(dateBucketFor(now - day, now)).toBe("yesterday");
    expect(dateBucketFor(now - 4 * day, now)).toBe("previous7days");
    expect(dateBucketFor(now - 20 * day, now)).toBe("previous30days");
    expect(dateBucketFor(now - 200 * day, now)).toBe("older");
    expect(dateBucketFor(Number.NEGATIVE_INFINITY, now)).toBe("older");
  });

  it("groups the timeline into ordered date buckets, newest first, across projects", () => {
    const now = Date.parse("2024-03-15T12:00:00Z");
    const day = 86400000;
    const groups = groupSessionsByDate(
      [
        { id: "old", project: "a", lastActivity: new Date(now - 100 * day).toISOString() },
        { id: "today-a", project: "a", lastActivity: new Date(now - 3600000).toISOString() },
        { id: "today-b", project: "b", lastActivity: new Date(now - 7200000).toISOString() },
        { id: "yesterday", project: "a", lastActivity: new Date(now - day).toISOString() },
      ],
      now,
    );
    expect(groups.map((g) => g.bucket)).toEqual(["today", "yesterday", "older"]);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["today-a", "today-b"]);
  });

  it("splits pinned sessions out in fixed pin order and leaves the rest untouched", () => {
    const { pinned, rest } = splitPinnedSessions([
      { id: "a", pinned: false, lastActivity: "2024-01-03T00:00:00Z" },
      { id: "b", pinned: true, pinOrder: 1, lastActivity: "2024-01-01T00:00:00Z" },
      { id: "c", pinned: true, pinOrder: 2, lastActivity: "2024-01-02T00:00:00Z" },
      { id: "d", pinned: false, lastActivity: "2024-01-04T00:00:00Z" },
    ]);
    expect(pinned.map((s) => s.id)).toEqual(["b", "c"]);
    expect(rest.map((s) => s.id)).toEqual(["a", "d"]);
  });

  it("returns empty pinned/rest for no sessions", () => {
    expect(splitPinnedSessions([])).toEqual({ pinned: [], rest: [] });
    expect(splitPinnedSessions()).toEqual({ pinned: [], rest: [] });
  });

  it("preserves known home rows across refreshes and prepends genuinely new sessions", () => {
    const previous = [
      { id: "a", lastActivity: "2024-01-01T00:00:00Z" },
      { id: "b", lastActivity: "2024-01-02T00:00:00Z" },
    ];
    const incoming = [
      { id: "new", lastActivity: "2024-01-04T00:00:00Z" },
      { id: "b", lastActivity: "2024-01-05T00:00:00Z" },
      { id: "a", lastActivity: "2024-01-03T00:00:00Z" },
    ];

    expect(stabilizeHomeSessionOrder(previous, incoming).map((session) => session.id)).toEqual([
      "new",
      "a",
      "b",
    ]);
  });

  it("damps known-session reloads and ignores sessions outside the bounded home", () => {
    const knownIds = new Set(["a", "b"]);
    const base = { knownIds, lastRefreshAt: 1000, throttleMs: 5000 };
    // Unknown or missing ids do not belong to this bounded home response.
    expect(shouldRefetchOnReload({ ...base, id: "zz", now: 1001 })).toBe(false);
    expect(shouldRefetchOnReload({ ...base, id: "", now: 1001 })).toBe(false);
    // Known id inside the throttle window → skip.
    expect(shouldRefetchOnReload({ ...base, id: "a", now: 5999 })).toBe(false);
    // Known id once the window elapses → refetch.
    expect(shouldRefetchOnReload({ ...base, id: "a", now: 6000 })).toBe(true);
  });

  it("formats token/cost metrics with k/M abbreviation and hides zeros", () => {
    expect(formatSessionMetrics({ tokenTotal: 12345, costTotal: 0.42 })).toBe("12.3k tok · $0.42");
    expect(formatSessionMetrics({ tokenTotal: 1500000, costTotal: 2 })).toBe("1.5M tok · $2.00");
    expect(formatSessionMetrics({ tokenTotal: 500, costTotal: 0 })).toBe("500 tok");
    expect(formatSessionMetrics({ tokenTotal: 0, costTotal: 1.5 })).toBe("$1.50");
    expect(formatSessionMetrics({ tokenTotal: 0, costTotal: 0 })).toBe("");
    expect(formatSessionMetrics({})).toBe("");
  });
});
