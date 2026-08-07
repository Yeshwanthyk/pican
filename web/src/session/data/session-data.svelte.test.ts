import { describe, expect, it } from "vitest";
import { SessionDataModel } from "./session-data.svelte.js";

// A small two-branch session: root → (old leaf) and root → mid → leaf.
const entries = [
  {
    id: "root",
    timestamp: "2026-01-01T00:00:00Z",
    type: "message",
    message: { role: "user", content: "start" },
  },
  {
    id: "old",
    parentId: "root",
    timestamp: "2026-01-01T00:01:00Z",
    type: "message",
    message: { role: "assistant", content: "old branch" },
  },
  {
    id: "mid",
    parentId: "root",
    timestamp: "2026-01-01T00:02:00Z",
    type: "message",
    message: { role: "assistant", content: "mid" },
  },
  {
    id: "leaf",
    parentId: "mid",
    timestamp: "2026-01-01T00:03:00Z",
    type: "message",
    message: { role: "user", content: "tell me about widgets" },
  },
];

const toolEntries = [
  {
    id: "tool-call-entry",
    timestamp: "2026-01-01T00:00:00Z",
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
    },
  },
  {
    id: "tool-result-entry",
    parentId: "tool-call-entry",
    timestamp: "2026-01-01T00:00:01Z",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "initial" }],
      details: { source: "initial" },
    },
  },
];

function model(extra = {}) {
  return new SessionDataModel({ entries, header: { cwd: "/x" }, leafId: "leaf", ...extra });
}

describe("SessionDataModel", () => {
  it("hydrates raw data and view state from a plain payload", () => {
    const m = model();
    expect(m.entries).toHaveLength(4);
    expect(m.header.cwd).toBe("/x");
    expect(m.currentLeafId).toBe("leaf");
    expect(m.currentTargetId).toBe("leaf");
  });

  it("derives lookups (byId / toolCallMap / labelMap)", () => {
    const m = model();
    expect(m.byId.get("mid")?.parentId).toBe("root");
    expect([...m.byId.keys()]).toEqual(["root", "old", "mid", "leaf"]);
  });

  it("indexes the canonical tool result on initial load", () => {
    const m = new SessionDataModel({
      entries: toolEntries,
      header: {},
      leafId: "tool-result-entry",
    });

    const lookup = m.toolResultMap.get("call-1");
    expect(lookup?.entry.id).toBe("tool-result-entry");
    expect(lookup?.message.content).toEqual([{ type: "text", text: "initial" }]);
    expect(lookup?.details).toEqual({ source: "initial" });
    expect(lookup?.resultCount).toBe(1);
  });

  it("keeps the tool-result map stable while indexing an append delta", () => {
    const m = new SessionDataModel({
      entries: toolEntries.slice(0, 1),
      header: {},
      leafId: "tool-call-entry",
    });
    const stableMap = m.toolResultMap;
    expect(stableMap.has("call-1")).toBe(false);

    m.reconcile([toolEntries[1]!], { isDelta: true });

    expect(m.toolResultMap).toBe(stableMap);
    expect(stableMap.get("call-1")?.entry.id).toBe("tool-result-entry");
    expect(stableMap.get("call-1")?.message.content).toEqual([{ type: "text", text: "initial" }]);
  });

  it("clears and refills the stable tool-result map on full and replaceable reconciles", () => {
    const m = new SessionDataModel({
      entries: toolEntries,
      header: {},
      leafId: "tool-result-entry",
    });
    const stableMap = m.toolResultMap;
    const originalResult = stableMap.get("call-1")?.entry;

    m.reconcile(toolEntries.slice(0, 1));
    expect(m.toolResultMap).toBe(stableMap);
    expect(stableMap.has("call-1")).toBe(false);

    const replacementResult = {
      ...toolEntries[1]!,
      message: {
        ...toolEntries[1]!.message,
        content: [{ type: "text", text: "replacement" }],
        details: { source: "replacement" },
      },
    };
    m.reconcile([toolEntries[0]!, replacementResult], { replaceExisting: true });

    expect(m.toolResultMap).toBe(stableMap);
    expect(stableMap.get("call-1")?.entry).not.toBe(originalResult);
    expect(stableMap.get("call-1")?.message.content).toEqual([
      { type: "text", text: "replacement" },
    ]);
    expect(stableMap.get("call-1")?.details).toEqual({ source: "replacement" });
  });

  it("uses the first duplicate as canonical while retaining aggregate activity semantics", () => {
    const duplicate = {
      ...toolEntries[1]!,
      id: "tool-result-duplicate",
      message: {
        ...toolEntries[1]!.message,
        content: [{ type: "text", text: "duplicate" }],
        isError: true,
        details: { diff: "@@ -1 +1 @@" },
      },
    };
    const m = new SessionDataModel({
      entries: [...toolEntries, duplicate],
      header: {},
      leafId: "tool-result-duplicate",
    });

    const lookup = m.toolResultMap.get("call-1");
    expect(lookup?.entry.id).toBe("tool-result-entry");
    expect(lookup?.message.content).toEqual([{ type: "text", text: "initial" }]);
    expect(lookup?.details).toEqual({ source: "initial" });
    expect(lookup?.resultCount).toBe(2);
    expect(lookup?.hasError).toBe(true);
    expect(lookup?.hasEdits).toBe(true);
  });

  it("derives the tree from entries", () => {
    const m = model();
    expect(m.tree.map((n) => n.entry.id)).toEqual(["root"]);
    expect(m.tree[0]?.children.map((n) => n.entry.id)).toEqual(["old", "mid"]);
  });

  it("derives the active path from the current leaf", () => {
    const m = model();
    expect([...m.activePathIds].sort()).toEqual(["leaf", "mid", "root"]);
    // 'old' is on the other branch, so it is not on the active path.
    expect(m.activePathIds.has("old")).toBe(false);
  });

  it("recomputes the active path when navigating", () => {
    const m = model();
    m.navigateTo("old");
    expect(m.currentLeafId).toBe("old");
    expect([...m.activePathIds].sort()).toEqual(["old", "root"]);
    expect(m.activePathIds.has("leaf")).toBe(false);
  });

  it("reactively recomputes derived state when entries change (live update)", () => {
    const m = model();
    expect(m.byId.has("leaf2")).toBe(false);

    m.applyLiveUpdate({
      entries: [
        ...entries,
        {
          id: "leaf2",
          parentId: "leaf",
          timestamp: "2026-01-01T00:04:00Z",
          type: "message",
          message: { role: "assistant", content: "widgets are great" },
        },
      ],
      header: { cwd: "/x" },
      leafId: "leaf2",
    });

    expect(m.byId.has("leaf2")).toBe(true);
    expect(m.nodeMap.get("leaf")?.children.map((n) => n.entry.id)).toEqual(["leaf2"]);
    // view state preserved across a live update (we were on 'leaf')
    expect(m.currentLeafId).toBe("leaf");
  });

  it("reconcile() merges new entries in place and advances the active leaf", () => {
    const m = model();
    m.navigateTo("leaf");
    m.reconcile([
      ...entries,
      {
        id: "leaf2",
        parentId: "leaf",
        timestamp: "2026-01-01T00:04:00Z",
        type: "message",
        message: { role: "assistant", content: "more" },
      },
    ]);
    expect(m.byId.has("leaf2")).toBe(true);
    // active leaf follows to the newest descendant of where we were.
    expect(m.currentLeafId).toBe("leaf2");
    expect(m.leafId).toBe("leaf2");
  });

  it("reconcile() ignores non-array input", () => {
    const m = model();
    m.reconcile(undefined);
    expect(m.entries).toHaveLength(4);
  });

  it("reconcile() prepends earlier entries without moving the active leaf off-branch", () => {
    const m = model();
    m.navigateTo("old");
    m.reconcile(entries);
    // staying on 'old' (a leaf), the newest descendant is itself.
    expect(m.currentLeafId).toBe("old");
  });

  it("reconcile() advances off the session-header leaf when real entries arrive", () => {
    // A brand-new session's JSONL contains only the {type:'session'} header
    // line, so hydration parks currentLeafId on that id. When the user sends
    // the first message the real chain has its own parentId:null root, so the
    // session header has no children to walk to. Reconcile must still pick the
    // newest real entry as the active leaf or the content pane stays empty.
    const m = new SessionDataModel({
      entries: [{ type: "session", id: "sess-1", timestamp: "2026-01-01T00:00:00Z" }],
      header: { id: "sess-1" },
      leafId: "sess-1",
    });
    expect(m.currentLeafId).toBe("sess-1");
    m.reconcile([
      { type: "session", id: "sess-1", timestamp: "2026-01-01T00:00:00Z" },
      {
        type: "model_change",
        id: "mc",
        parentId: null,
        timestamp: "2026-01-01T00:00:01Z",
        provider: "p",
        modelId: "m",
      },
      {
        type: "message",
        id: "u1",
        parentId: "mc",
        timestamp: "2026-01-01T00:00:02Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-01-01T00:00:03Z",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    expect(m.currentLeafId).toBe("a1");
    expect(m.activePath.map((e) => e.id)).toEqual(["mc", "u1", "a1"]);
  });

  it("reconcile(entries, { isDelta: true }) appends without touching existing entry identity", () => {
    const m = model();
    const originalRoot = m.byId.get("root");
    const originalOld = m.byId.get("old");
    const originalMid = m.byId.get("mid");
    const originalLeaf = m.byId.get("leaf");
    m.navigateTo("leaf");

    const leaf2 = {
      id: "leaf2",
      parentId: "leaf",
      timestamp: "2026-01-01T00:04:00Z",
      type: "message",
      message: { role: "assistant", content: "more" },
    };
    m.reconcile([leaf2], { isDelta: true });

    expect(m.entries).toHaveLength(5);
    // Existing entries are the exact same object references as before — the
    // delta path only ever pushes the new tail, it never rebuilds this.entries
    // from scratch.
    expect(m.byId.get("root")).toBe(originalRoot);
    expect(m.byId.get("old")).toBe(originalOld);
    expect(m.byId.get("mid")).toBe(originalMid);
    expect(m.byId.get("leaf")).toBe(originalLeaf);
    // leaf2 is a genuinely new entry — no prior identity to preserve, just
    // check it landed with the right content (Svelte's $state deeply proxies
    // pushed objects, so it is never Object.is-equal to the plain literal).
    expect(m.byId.get("leaf2")?.message?.content).toBe("more");
    expect(m.currentLeafId).toBe("leaf2");
    expect(m.nodeMap.get("leaf")?.children.map((n) => n.entry.id)).toEqual(["leaf2"]);
  });

  it("reconcile(entries) (full resync) reuses existing object references for known ids even when the incoming objects are fresh duplicates", () => {
    const m = model();
    const originalRoot = m.byId.get("root");
    const originalMid = m.byId.get("mid");
    const originalLeaf = m.byId.get("leaf");

    // Freshly-constructed objects with the same ids/content, as a real fetch
    // response would produce (never the same reference as what's already in
    // the model) — plus one genuinely new entry.
    const freshDuplicates = entries.map((e) => ({ ...e }));
    const leaf2 = {
      id: "leaf2",
      parentId: "leaf",
      timestamp: "2026-01-01T00:04:00Z",
      type: "message",
      message: { role: "assistant", content: "more" },
    };
    m.reconcile([...freshDuplicates, leaf2]);

    expect(m.entries).toHaveLength(5);
    expect(m.byId.get("root")).toBe(originalRoot);
    expect(m.byId.get("mid")).toBe(originalMid);
    expect(m.byId.get("leaf")).toBe(originalLeaf);
    // None of the merged entries are the fresh duplicate objects.
    expect(m.entries).not.toContain(freshDuplicates[0]);
    expect(m.entries).not.toContain(freshDuplicates[2]);
    // The genuinely new entry (no prior id) is used as-is (content-wise; see
    // the isDelta test above for why this isn't a toBe on the plain literal).
    expect(m.byId.get("leaf2")?.message?.content).toBe("more");
  });

  it("replaces known objects when stable ids belong to a mutable projection", () => {
    const m = model();
    const originalLeaf = m.byId.get("leaf");
    const replacement = {
      ...entries.find((entry) => entry.id === "leaf"),
      message: { role: "assistant", content: "completed canonical output" },
    };

    m.reconcile(
      entries.map((entry) => (entry.id === "leaf" ? replacement : { ...entry })),
      { replaceExisting: true },
    );

    expect(m.byId.get("leaf")).not.toBe(originalLeaf);
    expect(m.byId.get("leaf")?.message?.content).toBe("completed canonical output");
  });

  it("derives the ordered active path (root→leaf)", () => {
    const m = model();
    expect(m.activePath.map((e) => e.id)).toEqual(["root", "mid", "leaf"]);
    m.navigateTo("old");
    expect(m.activePath.map((e) => e.id)).toEqual(["root", "old"]);
  });

  it("applies the search filter reactively", () => {
    const m = model();
    const unfiltered = m.filteredNodes.length;
    m.searchQuery = "widgets";
    const filtered = m.filteredNodes.map((f) => f.node.entry.id);
    expect(filtered).toContain("leaf"); // matches "tell me about widgets"
    expect(m.filteredNodes.length).toBeLessThan(unfiltered);
  });

  it("builds a reactive model from an embedded payload via fromPayload", () => {
    const m = SessionDataModel.fromPayload(
      {
        header: {},
        entries,
        leafId: "leaf",
        projectionMode: "replaceable-projection",
      },
      new URLSearchParams("targetId=mid"),
    );
    expect(m.currentLeafId).toBe("leaf");
    expect(m.currentTargetId).toBe("mid");
    expect(m.projectionMode).toBe("replaceable-projection");
  });
});
