import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSessionPageState,
  firstMessageStub,
  loadSessionPageState,
  newestLeaf,
  normalizeSessionRuntime,
} from "./session-page-data";
import { prefetchSession, resetSessionPrefetch } from "./session-prefetch";

afterEach(() => resetSessionPrefetch());

const btoaImpl = (value: string) => Buffer.from(value, "binary").toString("base64");
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const decodePayload = (encoded: string) =>
  decodeJson(Buffer.from(encoded, "base64").toString("utf8"));

describe("session-page-data", () => {
  it("finds the newest entry id", () => {
    expect(newestLeaf([{ id: "a" }, {}, { id: "b" }])).toBe("b");
    expect(newestLeaf([{}, null])).toBe("");
  });

  it("skips the session-header line so a brand-new session does not pick metadata as the leaf", () => {
    expect(newestLeaf([{ type: "session", id: "sess-1" }])).toBe("");
    expect(newestLeaf([{ type: "session", id: "sess-1" }, { id: "a" }])).toBe("a");
    expect(newestLeaf([{ id: "a" }, { type: "label", id: "l1" }])).toBe("a");
  });

  it("renders an escaped first-message stub", () => {
    const html = firstMessageStub([
      { type: "message", message: { role: "user", content: "<hello> & bye" } },
    ]);
    expect(html).toContain("&lt;hello&gt; &amp; bye");
    expect(html).not.toContain("<hello>");
  });

  it("normalizes runtime metadata from payload/header and defaults old sessions to Pi", () => {
    expect(normalizeSessionRuntime({ header: { id: "pi-uuid" } })).toEqual({
      runtime: "pi",
      nativeId: "",
      sessionUUID: "pi-uuid",
    });
    expect(
      normalizeSessionRuntime({
        runtime: "codex",
        nativeId: "thread-1",
        projectionMode: "replaceable-projection",
        header: { id: "projection-id" },
      }),
    ).toEqual({ runtime: "codex", nativeId: "thread-1", sessionUUID: "projection-id" });
    expect(
      normalizeSessionRuntime({ header: { runtime: "codex", nativeId: "thread-header" } }),
    ).toMatchObject({ runtime: "codex", nativeId: "thread-header" });
  });

  it("builds state and encoded payload from API data", () => {
    const state = buildSessionPageState({
      sessionId: "s.jsonl",
      scratchpad: "notes",
      btoaImpl,
      data: {
        name: "Title",
        header: { cwd: "/tmp/project" },
        entries: [{ id: "a" }, { id: "b" }],
        total: 5,
        from: 3,
        chatAvailable: false,
        model: "sonnet",
        modelProvider: "anthropic",
        runtime: "codex",
        nativeId: "thread-1",
        projectionMode: "replaceable-projection",
      },
    });

    expect(state.title).toBe("Title");
    expect(state.cwd).toBe("/tmp/project");
    expect(state.scratchpad).toBe("notes");
    expect(state.chatAvailable).toBe(false);
    expect(state.chatDisabledReason).toContain("chat is disabled");
    expect(state.modelLabel).toBe("sonnet @ anthropic");
    expect(state.runtime).toBe("codex");
    expect(state.nativeId).toBe("thread-1");
    expect(decodePayload(state.payloadBase64)).toMatchObject({
      name: "Title",
      leafId: "b",
      total: 5,
      from: 3,
      truncated: true,
      projectionMode: "replaceable-projection",
      header: { cwd: "/tmp/project", runtime: "codex", nativeId: "thread-1" },
    });
  });

  it("uses the OpenCode display label while trusting explicit server capabilities", () => {
    const state = buildSessionPageState({
      sessionId: "opencode.jsonl",
      btoaImpl,
      data: {
        runtime: "opencode",
        nativeId: "ses_123",
        header: { cwd: "/tmp/project" },
        capabilities: {
          create: true,
          resume: true,
          fork: true,
          clone: true,
          rename: true,
          delete: true,
          chat: true,
          cancel: true,
          modelListing: true,
          modelSwitching: true,
        },
      },
    });

    expect(state.runtimeLabel).toBe("OpenCode");
    expect(state.capabilities).toEqual({
      create: true,
      resume: true,
      fork: true,
      clone: true,
      rename: true,
      archive: false,
      unarchive: false,
      delete: true,
      chat: true,
      cancel: true,
      steer: false,
      persistentQueue: false,
      images: false,
      files: false,
      modelListing: true,
      modelSwitching: true,
      effortSelection: false,
      reasoningSelection: false,
      slashCommands: false,
      subagents: false,
      interactiveApprovals: false,
      userQuestions: false,
    });
  });

  it("only fetches the session on the network path; the scratchpad is the sidebar’s job", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: RequestInfo | URL) => {
      seen.push(String(url));
      if (String(url).startsWith("/api/session")) {
        return new Response(
          JSON.stringify({ name: "Loaded", header: { cwd: "/tmp/space path" }, entries: [] }),
        );
      }
      return new Response("{}", { status: 500 });
    };

    const state = await loadSessionPageState({
      locationSearch: "?id=s.jsonl",
      fetchImpl,
      btoaImpl,
    });

    expect(state.title).toBe("Loaded");
    expect(state.scratchpad).toBe("");
    expect(seen).toEqual(["/api/session?id=s.jsonl&paginate=1"]);
  });

  it("uses the embedded bootstrap payload without fetching", async () => {
    const b64utf8 = (value: string) => Buffer.from(value, "utf8").toString("base64");
    const bootstrap = b64utf8(
      JSON.stringify({
        id: "s.jsonl",
        data: {
          name: "Embedded",
          header: { cwd: "/tmp/x" },
          entries: [],
          model: "haiku",
          modelProvider: "anthropic",
          chatAvailable: true,
        },
        scratchpad: "notes",
      }),
    );
    const documentImpl = {
      getElementById: (id: string) =>
        id === "pican-session-bootstrap" ? { textContent: bootstrap } : null,
    };
    let fetched = false;
    const fetchImpl = async () => {
      fetched = true;
      return new Response("{}", { status: 500 });
    };

    const state = await loadSessionPageState({
      locationSearch: "?id=s.jsonl",
      fetchImpl,
      btoaImpl,
      documentImpl,
    });

    expect(fetched).toBe(false);
    expect(state.title).toBe("Embedded");
    expect(state.scratchpad).toBe("notes");
    expect(state.modelLabel).toBe("haiku @ anthropic");
  });

  it("reuses a prefetched /api/session payload instead of fetching again", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ name: "Prefetched", header: { cwd: "/p" }, entries: [] }),
      );
    };

    prefetchSession("s.jsonl", { fetchImpl });
    const state = await loadSessionPageState({
      locationSearch: "?id=s.jsonl",
      fetchImpl,
      btoaImpl,
    });

    expect(state.title).toBe("Prefetched");
    // Only one /api/session call total, the one started by prefetchSession.
    expect(calls).toEqual(["/api/session?id=s.jsonl&paginate=1"]);
  });

  it("falls back to a fresh fetch when the prefetch rejects", async () => {
    let attempt = 0;
    const fetchImpl = async () => {
      attempt++;
      if (attempt === 1) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ name: "Recovered", header: {}, entries: [] }));
    };

    prefetchSession("s.jsonl", { fetchImpl });
    const state = await loadSessionPageState({
      locationSearch: "?id=s.jsonl",
      fetchImpl,
      btoaImpl,
    });

    expect(state.title).toBe("Recovered");
    expect(attempt).toBe(2);
  });

  it("falls back to fetch when the bootstrap is for a different session", async () => {
    const b64utf8 = (value: string) => Buffer.from(value, "utf8").toString("base64");
    const bootstrap = b64utf8(
      JSON.stringify({ id: "other.jsonl", data: { name: "Other", entries: [] } }),
    );
    const documentImpl = {
      getElementById: (id: string) =>
        id === "pican-session-bootstrap" ? { textContent: bootstrap } : null,
    };
    let fetched = false;
    const fetchImpl = async (url: RequestInfo | URL) => {
      fetched = true;
      if (String(url).startsWith("/api/session")) {
        return new Response(JSON.stringify({ name: "Fetched", header: {}, entries: [] }));
      }
      return new Response(JSON.stringify({ content: "" }));
    };

    const state = await loadSessionPageState({
      locationSearch: "?id=s.jsonl",
      fetchImpl,
      btoaImpl,
      documentImpl,
    });

    expect(fetched).toBe(true);
    expect(state.title).toBe("Fetched");
  });
});
