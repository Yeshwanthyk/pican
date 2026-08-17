import type { SubagentList } from "../lib/schema";
import { effects } from "../shared/api";
import { runPromise } from "../lib/runtime";

export type Subagent = SubagentList["subagents"][number];

interface SubagentInput {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly harness?: unknown;
  readonly status?: unknown;
  readonly spawnedAt?: unknown;
  readonly parentSession?: unknown;
  readonly parentProject?: unknown;
  readonly childSession?: unknown;
  readonly childProject?: unknown;
  readonly lastActivity?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const statusValue = (value: unknown): Subagent["status"] =>
  value === "running" || value === "done" || value === "error" ? value : "unknown";

export function normalizeSubagent(subagent: SubagentInput = {}): Subagent {
  return {
    id: stringValue(subagent.id),
    title: stringValue(subagent.title),
    harness: stringValue(subagent.harness),
    status: statusValue(subagent.status),
    spawnedAt: stringValue(subagent.spawnedAt),
    parentSession: stringValue(subagent.parentSession),
    parentProject: stringValue(subagent.parentProject),
    childSession: stringValue(subagent.childSession),
    childProject: stringValue(subagent.childProject),
    lastActivity: stringValue(subagent.lastActivity),
  };
}

export function subagentActivityTime(subagent: SubagentInput = {}): string {
  return stringValue(subagent.lastActivity) || stringValue(subagent.spawnedAt);
}

const SUBAGENT_STATUS_RANK: Readonly<Record<Subagent["status"], number>> = {
  running: 0,
  error: 1,
  done: 2,
  unknown: 3,
};

// Cursor-style ordering: live agents first, then failures, then settled; most
// recently active first within each status group. Returns a new array and
// never mutates the input. Equal or missing activity times keep input order
// because Array.prototype.sort is stable.
export function orderSubagents(subs: ReadonlyArray<Subagent>): ReadonlyArray<Subagent> {
  return [...subs].sort((a, b) => {
    const byStatus = SUBAGENT_STATUS_RANK[a.status] - SUBAGENT_STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
    return subagentActivityTime(b).localeCompare(subagentActivityTime(a));
  });
}

export function subagentProject(subagent: SubagentInput = {}): string {
  return stringValue(subagent.childProject) || stringValue(subagent.parentProject);
}

// Cursor-style loop: a subagent card opens the child transcript but keeps a
// `parent` param in the URL so the child page can offer a one-click way back.
// Prefers the child session (with the parent param when one exists), falls
// back to the parent session href for runs without a recorded child.
export function subagentTranscriptHref(subagent: SubagentInput = {}): string {
  const child = stringValue(subagent.childSession);
  const parent = stringValue(subagent.parentSession);
  const id = child || parent;
  if (!id) return "";
  const params = new URLSearchParams({ id });
  if (child && parent) params.set("parent", parent);
  return `/session?${params.toString()}`;
}

// Read the `parent` session param out of a route search string ("" when
// absent) so the session page can offer a return link into the parent.
export function parentSessionParam(search: string): string {
  if (!search) return "";
  if (search.startsWith("?")) search = search.slice(1);
  const value = new URLSearchParams(search).get("parent") ?? "";
  return value.trim();
}

export function defaultFetchSubagents(session = "") {
  return runPromise(effects.subagents.list(session || undefined));
}
