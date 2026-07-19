import type { WorkflowRun, WorkflowRunDetail } from "../lib/schema";
import { effects } from "../shared/api";
import { runPromise } from "../lib/runtime";

export type WorkflowSummary = Required<WorkflowRun>;

interface WorkflowPhase {
  readonly id?: string;
  readonly title?: string;
}

interface WorkflowProgressInput {
  readonly phases?: ReadonlyArray<WorkflowPhase>;
  readonly phaseCount?: number;
  readonly currentPhaseNumber?: number;
  readonly currentPhase?: string;
  readonly status?: string;
}

interface WorkflowAgent {
  readonly label?: string;
  readonly [key: string]: unknown;
}

export interface WorkflowTranscriptGroup {
  readonly index: string;
  readonly agent: WorkflowAgent | null;
  readonly entries: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export function normalizeWorkflowSummary(workflow: Partial<WorkflowRun> = {}): WorkflowSummary {
  return {
    runId: typeof workflow.runId === "string" ? workflow.runId : "",
    name: typeof workflow.name === "string" ? workflow.name : "",
    description: typeof workflow.description === "string" ? workflow.description : "",
    status: typeof workflow.status === "string" ? workflow.status : "",
    startedAt: typeof workflow.startedAt === "string" ? workflow.startedAt : "",
    finishedAt: typeof workflow.finishedAt === "string" ? workflow.finishedAt : "",
    currentPhase: typeof workflow.currentPhase === "string" ? workflow.currentPhase : "",
    currentPhaseNumber: Number.isFinite(workflow.currentPhaseNumber)
      ? (workflow.currentPhaseNumber ?? 0)
      : 0,
    phaseCount: Number.isFinite(workflow.phaseCount) ? (workflow.phaseCount ?? 0) : 0,
    agentCount: Number.isFinite(workflow.agentCount) ? (workflow.agentCount ?? 0) : 0,
    hasResult: Boolean(workflow.hasResult),
    hasTranscripts: Boolean(workflow.hasTranscripts),
  };
}

export function workflowPhaseProgress(workflow: WorkflowProgressInput = {}): {
  readonly current: number;
  readonly total: number;
} {
  const phases = Array.isArray(workflow.phases) ? workflow.phases : [];
  const total = Number.isFinite(workflow.phaseCount) ? (workflow.phaseCount ?? 0) : phases.length;
  if (total === 0) return { current: 0, total: 0 };
  if (workflow.status === "completed") return { current: total, total };
  if (Number.isFinite(workflow.currentPhaseNumber) && (workflow.currentPhaseNumber ?? 0) > 0) {
    return { current: Math.min(workflow.currentPhaseNumber ?? 0, total), total };
  }
  const currentIndex = phases.findIndex(
    (phase) => phase.title === workflow.currentPhase || phase.id === workflow.currentPhase,
  );
  return { current: currentIndex >= 0 ? currentIndex + 1 : 0, total };
}

export function workflowTranscriptGroups(
  transcripts: unknown,
  agents: ReadonlyArray<WorkflowAgent> = [],
): ReadonlyArray<WorkflowTranscriptGroup> {
  if (!transcripts || typeof transcripts !== "object" || Array.isArray(transcripts)) return [];
  return Object.entries(transcripts)
    .filter((entry): entry is [string, ReadonlyArray<unknown>] => Array.isArray(entry[1]))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([index, entries]) => ({
      index,
      agent: agents[Number(index)] ?? null,
      entries: entries.filter(
        (entry): entry is Readonly<Record<string, unknown>> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      ),
    }));
}

export function formatWorkflowDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function defaultFetchWorkflows(session = "") {
  return runPromise(effects.workflows.list(session || undefined));
}

export function defaultFetchWorkflowRun(runId: string): Promise<WorkflowRunDetail> {
  return runPromise(effects.workflows.detail(runId));
}
