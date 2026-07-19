// Reactive session model (Svelte 5 runes).
//
// This is the single source of truth for a session page. It is intentionally a
// data-shape-compatible replacement for the plain model produced by
// createSessionDataModel() (session-data.js): it exposes the same fields
// (entries, header, byId, toolCallMap, labelMap, leafId, urlTargetId,
// systemPrompt, tools, renderedTools, total/from/truncated) so live components
// and the static export can share session render helpers without field changes,
// while also being reactive so Svelte views update automatically.
//
// Key reactivity rules:
//   • `entries` is a $state array, so reconcile()'s in-place splice is tracked.
//   • byId / toolCallMap / labelMap are STABLE SvelteMaps, refilled IN PLACE
//     (clear+set). Stable identity matters because the entry renderer / chat
//     composer capture these Map references once; mutating-in-place keeps that
//     capture live. SvelteMap (not a plain `$state(new Map())`) is required so
//     that .set/.clear are themselves reactive — a derived that reads byId must
//     recompute when entries are prepended without the active leaf changing
//     (e.g. the load-earlier path), where no other reactive field changes.
//   • view state (currentLeafId/currentTargetId/filterMode/searchQuery) is
//     $state, so the tree highlight/filter follow navigation reactively.
//
// It deliberately holds no rendering/DOM/SSE/fetch logic, so it is safe to
// import from both the live app and the static export bundle.

import { SvelteMap } from "svelte/reactivity";
import { buildSessionLookups } from "./session-data.js";
import { sessionEntryFromUnknown } from "./session-types.js";
import type {
  SessionDataShape,
  SessionEntry,
  SessionPayload,
  ToolCallInfo,
  UnknownRecord,
} from "./session-types.js";
import {
  buildTree,
  buildTreeNodeMap,
  flattenTree,
  buildActivePathIds,
  findNewestLeaf,
  getPath,
  stitchOrphanRoots,
} from "../tree/session-tree.js";
import { filterNodes } from "../tree/session-filter.js";
import type { TreeEntry } from "../tree/session-tree.js";

type SessionFilterMode = "all" | "default" | "user-only" | "no-tools" | "labeled-only";

const normalizeStitchedEntries = (entries: ReadonlyArray<TreeEntry>): SessionEntry[] =>
  entries.flatMap((entry) => {
    const normalized = sessionEntryFromUnknown(entry);
    return normalized ? [normalized] : [];
  });

function refillMap<K, V>(target: Map<K, V>, source?: ReadonlyMap<K, V>): void {
  target.clear();
  if (source) source.forEach((value, key) => target.set(key, value));
}

export class SessionDataModel {
  // ── raw data (compatible fields for the plain model shape) ──────────────
  entries = $state<SessionEntry[]>([]);
  header = $state<UnknownRecord>({});
  systemPrompt = $state<unknown>(null);
  tools = $state<unknown>(null);
  renderedTools = $state<unknown>(null);
  leafId = $state("");
  urlLeafId = $state<string | null>(null);
  urlTargetId = $state<string | null>(null);
  total = $state(0);
  from = $state(0);
  truncated = $state(false);

  // Stable, in-place-mutated reactive lookup Maps (see header comment).
  // SvelteMap makes .set/.clear reactive while keeping a stable object identity.
  byId = new SvelteMap<string, SessionEntry>();
  toolCallMap = new SvelteMap<string, ToolCallInfo>();
  labelMap = new SvelteMap<string, string>();

  // ── view state ──────────────────────────────────────────────────────────
  currentLeafId = $state("");
  currentTargetId = $state("");
  filterMode = $state<SessionFilterMode>("default");
  searchQuery = $state("");

  // ── derived tree (recompute on entries / labelMap / view changes) ────────
  tree = $derived(buildTree(this.entries, this.labelMap));
  nodeMap = $derived(buildTreeNodeMap(this.tree));
  activePathIds = $derived(
    buildActivePathIds(this.currentTargetId || this.currentLeafId, this.byId),
  );
  // Ordered root→leaf entries for the message pane (what the content view
  // renders). Recomputes when entries or the active leaf change.
  activePath = $derived(getPath(this.currentLeafId, this.byId));
  flatNodes = $derived(flattenTree(this.tree, this.activePathIds));
  filteredNodes = $derived(
    filterNodes(this.flatNodes, this.currentLeafId, {
      filterMode: this.filterMode,
      searchQuery: this.searchQuery,
    }),
  );

  constructor(data?: SessionDataShape | null) {
    if (data) this.#hydrate(data);
  }

  // Build a reactive model straight from an embedded payload + URL params.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read-only default param for URL parsing, not reactive state
  static fromPayload(payload: SessionPayload | null, params = new URLSearchParams()) {
    // Lazy import avoidance: createSessionDataModel lives in session-data.js and
    // would create a cycle if imported at top level alongside buildSessionLookups
    // there; build the shape inline instead.
    const header = payload?.header || {};
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const defaultLeafId = payload?.leafId || "";
    return new SessionDataModel({
      header,
      entries,
      leafId: params.get("leafId") || defaultLeafId,
      urlLeafId: params.get("leafId"),
      urlTargetId: params.get("targetId"),
      systemPrompt: payload?.systemPrompt ?? null,
      tools: payload?.tools ?? null,
      renderedTools: payload?.renderedTools ?? null,
      total: payload?.total,
      from: payload?.from,
      truncated: payload?.truncated,
    });
  }

  // Initial / full load: reset data + view state from a payload-shaped object
  // (as produced by createSessionDataModel or fromPayload's argument).
  load(data: SessionDataShape): void {
    this.#hydrate(data);
  }

  // Replace data in place, preserving view state. Used by the static export and
  // standalone consumers; the live app's reload path uses reconcile() below.
  applyLiveUpdate(data: SessionDataShape): void {
    this.#hydrate(data, { preserveView: true });
  }

  #hydrate(
    data: SessionDataShape,
    { preserveView = false }: { readonly preserveView?: boolean } = {},
  ): void {
    this.entries = normalizeStitchedEntries(
      stitchOrphanRoots(Array.isArray(data.entries) ? data.entries : []),
    );
    this.header = data.header ?? {};
    this.systemPrompt = data.systemPrompt ?? null;
    this.tools = data.tools ?? null;
    this.renderedTools = data.renderedTools ?? null;
    this.total =
      typeof data.total === "number" && Number.isInteger(data.total)
        ? data.total
        : this.entries.length;
    this.from = typeof data.from === "number" && Number.isInteger(data.from) ? data.from : 0;
    this.truncated = Boolean(data.truncated) || this.from > 0 || this.entries.length < this.total;
    this.urlLeafId = data.urlLeafId ?? null;
    this.urlTargetId = data.urlTargetId ?? null;

    // Refill the stable lookup maps in place from the entries (authoritative),
    // keeping their object identity for any captured references.
    const lk = buildSessionLookups(this.entries);
    refillMap(this.byId, lk.byId);
    refillMap(this.toolCallMap, lk.toolCallMap);
    refillMap(this.labelMap, lk.labelMap);

    this.leafId = data.leafId ?? data.defaultLeafId ?? "";

    if (!preserveView) {
      this.currentLeafId = this.leafId;
      this.currentTargetId = data.urlTargetId || this.currentLeafId;
    } else if (this.currentLeafId && !this.byId.has(this.currentLeafId)) {
      this.currentLeafId = this.leafId || this.currentLeafId;
    }
  }

  // Move the active leaf/target (target defaults to the leaf).
  navigateTo(leafId: string, targetId = leafId): void {
    this.currentLeafId = leafId;
    this.currentTargetId = targetId;
  }

  // Newest leaf under a node — used for click-to-navigate.
  newestLeaf(nodeId: string): string {
    return findNewestLeaf(nodeId, this.nodeMap);
  }

  // Live-reload / load-earlier reconciliation: merge entries in place and
  // refill the stable lookup maps (all reactive, so the Svelte tree, content
  // pane, and artifact panel update automatically), then advance the active
  // leaf to the newest descendant of the current one (or the last real entry).
  // Unlike load(), this preserves view state and never resets the target unless
  // it was unset.
  //
  // `entries` is either:
  //   • a delta tail (isDelta: true) — just the entries appended since the
  //     caller's last known count (see /api/session?afterCount=). These are
  //     pushed onto this.entries as-is; existing entries are never touched, so
  //     their object identity is trivially preserved.
  //   • a full list (isDelta: false, the default — also what LoadEarlier.svelte
  //     passes when prepending older entries) — reconciled by id against the
  //     current byId map, reusing the existing object for any id already known
  //     rather than the freshly-fetched duplicate. Session JSONL files are
  //     append-only once written (renames/labels append new lines rather than
  //     mutating existing ones — see AGENTS.md), so an existing entry's content
  //     never changes out from under its id, making reuse-by-id safe: it lets
  //     components keyed on entry identity (not just id) skip re-rendering
  //     content that hasn't actually changed. Replaceable projections pass
  //     replaceExisting:true because stable IDs may carry newer content/status.
  reconcile(
    entries: ReadonlyArray<UnknownRecord> | undefined,
    {
      isDelta = false,
      replaceExisting = false,
    }: { readonly isDelta?: boolean; readonly replaceExisting?: boolean } = {},
  ): void {
    if (!Array.isArray(entries)) return;
    const normalizedEntries = entries.flatMap((entry) => {
      const normalized = sessionEntryFromUnknown(entry);
      return normalized ? [normalized] : [];
    });
    if (isDelta) {
      const combined = normalizeStitchedEntries(
        stitchOrphanRoots([...this.entries, ...normalizedEntries]),
      );
      this.entries.push(...combined.slice(this.entries.length));
    } else {
      const stitched = normalizeStitchedEntries(stitchOrphanRoots(normalizedEntries));
      // Pi entries are append-only, so retaining known objects avoids needless
      // rerenders. Codex projections replace in-progress tool entries under
      // stable IDs; those callers must accept the freshly fetched objects.
      const merged = replaceExisting
        ? stitched
        : stitched.map((entry) => (entry?.id && this.byId.get(entry.id)) || entry);
      this.entries.splice(0, this.entries.length, ...merged);
    }
    const lk = buildSessionLookups(this.entries);
    refillMap(this.byId, lk.byId);
    refillMap(this.toolCallMap, lk.toolCallMap);
    refillMap(this.labelMap, lk.labelMap);

    // Reuse the $derived tree instead of building a second one here — reading
    // this.nodeMap after the mutations above re-evaluates it synchronously
    // (Svelte 5 $derived recomputes on read even outside a component/effect).
    const nodeMap = this.nodeMap;
    let nextLeafId =
      this.currentLeafId && nodeMap.has(this.currentLeafId)
        ? findNewestLeaf(this.currentLeafId, nodeMap)
        : "";
    // The session-header line ({type:'session'}) has its own id but is metadata,
    // not a conversation entry. When a brand-new session is first opened it is the
    // only entry, so hydration parks currentLeafId on it; after the user sends a
    // message the real chain (model_change → … → assistant) lives on a separate
    // root with parentId:null, so findNewestLeaf has no children to walk and returns
    // the session id, leaving activePath rendering nothing. Fall back to the last
    // real entry in that case.
    if (!nextLeafId || this.byId.get(nextLeafId)?.type === "session") {
      for (let i = this.entries.length - 1; i >= 0; i -= 1) {
        const entry = this.entries[i];
        if (entry?.id && entry.type !== "label" && entry.type !== "session") {
          nextLeafId = entry.id;
          break;
        }
      }
    }
    if (nextLeafId) {
      this.leafId = nextLeafId;
      this.currentLeafId = nextLeafId;
      if (!this.currentTargetId) this.currentTargetId = nextLeafId;
    }
  }
}
