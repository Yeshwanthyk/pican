import { getJSON } from "../shared/api.js";

export function normalizeWorkflowSummary(workflow = {}) {
  return {
    runId: typeof workflow.runId === "string" ? workflow.runId : "",
    name: typeof workflow.name === "string" ? workflow.name : "",
    description: typeof workflow.description === "string" ? workflow.description : "",
    status: typeof workflow.status === "string" ? workflow.status : "",
    startedAt: typeof workflow.startedAt === "string" ? workflow.startedAt : "",
    finishedAt: typeof workflow.finishedAt === "string" ? workflow.finishedAt : "",
    currentPhase: typeof workflow.currentPhase === "string" ? workflow.currentPhase : "",
    currentPhaseNumber: Number.isFinite(workflow.currentPhaseNumber)
      ? workflow.currentPhaseNumber
      : 0,
    phaseCount: Number.isFinite(workflow.phaseCount) ? workflow.phaseCount : 0,
    agentCount: Number.isFinite(workflow.agentCount) ? workflow.agentCount : 0,
    hasResult: !!workflow.hasResult,
    hasTranscripts: !!workflow.hasTranscripts,
  };
}

export function workflowPhaseProgress(workflow = {}) {
  const phases = Array.isArray(workflow.phases) ? workflow.phases : [];
  const total = Number.isFinite(workflow.phaseCount) ? workflow.phaseCount : phases.length;
  if (total === 0) return { current: 0, total: 0 };
  if (workflow.status === "completed") return { current: total, total };
  if (Number.isFinite(workflow.currentPhaseNumber) && workflow.currentPhaseNumber > 0) {
    return { current: Math.min(workflow.currentPhaseNumber, total), total };
  }
  const currentIndex = phases.findIndex(
    (phase) => phase?.title === workflow.currentPhase || phase?.id === workflow.currentPhase,
  );
  return { current: currentIndex >= 0 ? currentIndex + 1 : 0, total };
}

export function workflowTranscriptGroups(transcripts, agents = []) {
  if (!transcripts || typeof transcripts !== "object" || Array.isArray(transcripts)) return [];
  return Object.entries(transcripts)
    .filter(([, entries]) => Array.isArray(entries))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([index, entries]) => ({
      index,
      agent: agents[Number(index)] || null,
      entries,
    }));
}

export function formatWorkflowDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function defaultFetchWorkflows(session = "") {
  return getJSON("/api/workflows" + (session ? "?session=" + encodeURIComponent(session) : ""));
}

export function defaultFetchWorkflowRun(runId) {
  return getJSON("/api/workflows/run?runId=" + encodeURIComponent(runId));
}
