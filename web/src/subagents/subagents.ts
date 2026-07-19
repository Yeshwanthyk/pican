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

export function subagentProject(subagent: SubagentInput = {}): string {
  return stringValue(subagent.childProject) || stringValue(subagent.parentProject);
}

export function defaultFetchSubagents(session = "") {
  return runPromise(effects.subagents.list(session || undefined));
}
