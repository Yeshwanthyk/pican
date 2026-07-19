import {
  contentBlocksFromUnknown,
  isUnknownRecord,
  type SessionEntry,
} from "../data/session-types.js";

const MAX_BREAKDOWN_TOOLS = 4;
const INTERACTIVE_TOOL_NAMES = new Set([
  "ask_user",
  "ask_user_question",
  "pican_ask_user_question",
]);

export interface ToolBreakdown {
  readonly tools: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  readonly remaining: number;
}

export type ToolRunStatus = "error" | "pending" | "success";
export type ToolRunRenderItem =
  | { readonly kind: "entry"; readonly entry: SessionEntry }
  | {
      readonly kind: "group";
      readonly entries: SessionEntry[];
      readonly toolCount: number;
      readonly thinkingCount: number;
      readonly hasEdits: boolean;
      readonly durationSeconds: number;
      readonly startedAt: string;
      readonly breakdown: ToolBreakdown;
      readonly status: ToolRunStatus;
    };

function analyzeToolRunEntry(
  entry: SessionEntry | undefined,
  completedCallIds: ReadonlySet<string>,
): string[] | null {
  if (entry?.type === "custom_message" && entry.customType === "subagent-result") {
    return null;
  }

  if (entry?.type !== "message") return null;

  const message = entry.message;
  if (message?.role === "toolResult") return [];
  if (message?.role === "bashExecution") return null;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;

  const toolNames: string[] = [];
  let hasToolActivity = false;

  for (const block of contentBlocksFromUnknown(message.content)) {
    if (block?.type === "toolCall") {
      if (
        typeof block.name === "string" &&
        INTERACTIVE_TOOL_NAMES.has(block.name) &&
        typeof block.id === "string" &&
        !completedCallIds.has(block.id)
      )
        return null;
      hasToolActivity = true;
      toolNames.push(
        typeof block.name === "string" && block.name.trim() ? block.name.trim() : "tool",
      );
      continue;
    }
    if (block?.type === "thinking") {
      hasToolActivity = true;
      continue;
    }
    if (block?.type === "text" && !String(block.text ?? "").trim()) continue;
    return null;
  }

  return hasToolActivity ? toolNames : null;
}

function canStartToolRun(entry: SessionEntry | undefined): boolean {
  return entry?.type === "message" && entry.message?.role === "assistant";
}

function collectCompletedCallIds(activePath: ReadonlyArray<SessionEntry>): Set<string> {
  return new Set(
    activePath
      .filter((entry) => entry?.type === "message" && entry.message?.role === "toolResult")
      .flatMap((entry) => {
        const id = entry.message?.toolCallId;
        return id ? [id] : [];
      }),
  );
}

function toolRunStatus(
  entries: ReadonlyArray<SessionEntry>,
  toolCallIds: ReadonlyArray<string>,
  completedCallIds: ReadonlySet<string>,
): ToolRunStatus {
  const failed = entries.some((entry) => {
    if (entry?.type === "custom_message" && entry.customType === "subagent-result") {
      return entry.details?.status === "error";
    }
    if (entry?.type !== "message") return false;
    if (entry.message?.role === "toolResult") return entry.message.isError === true;
    if (entry.message?.role === "bashExecution") {
      return (
        entry.message.cancelled === true ||
        (entry.message.exitCode !== null &&
          entry.message.exitCode !== undefined &&
          entry.message.exitCode !== 0)
      );
    }
    return false;
  });

  if (failed) return "error";
  return toolCallIds.some((id) => !completedCallIds.has(id)) ? "pending" : "success";
}

function activityMetadata(
  entries: ReadonlyArray<SessionEntry>,
  toolCallIds: ReadonlyArray<string>,
): {
  readonly thinkingCount: number;
  readonly hasEdits: boolean;
  readonly durationSeconds: number;
  readonly startedAt: string;
} {
  const resultByCallId = new Map(
    entries.flatMap((entry) => {
      const message = entry.type === "message" ? entry.message : null;
      return message?.role === "toolResult" && message.toolCallId
        ? [[message.toolCallId, message] as const]
        : [];
    }),
  );
  const thinkingCount = entries.reduce(
    (count, entry) =>
      count +
      (entry.type === "message"
        ? contentBlocksFromUnknown(entry.message?.content).filter(
            (block) => block.type === "thinking" && String(block.thinking ?? "").trim(),
          ).length
        : 0),
    0,
  );
  const timestamps = entries
    .map((entry) => Date.parse(entry.timestamp ?? ""))
    .filter(Number.isFinite);
  const first = timestamps[0];
  const last = timestamps.at(-1);
  return {
    thinkingCount,
    hasEdits: toolCallIds.some((id) => {
      const details = resultByCallId.get(id)?.details;
      return isUnknownRecord(details) && typeof details.diff === "string";
    }),
    durationSeconds:
      first === undefined || last === undefined
        ? 0
        : Math.max(0, Math.round((last - first) / 1000)),
    startedAt: entries.find((entry) => typeof entry.timestamp === "string")?.timestamp ?? "",
  };
}

function buildToolBreakdown(toolNames: ReadonlyArray<string>): ToolBreakdown {
  const counts = new Map<string, { name: string; count: number; firstIndex: number }>();
  toolNames.forEach((name, index) => {
    const current = counts.get(name);
    if (current) current.count += 1;
    else counts.set(name, { name, count: 1, firstIndex: index });
  });

  const sorted = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.firstIndex - b.firstIndex,
  );
  return {
    tools: sorted.slice(0, MAX_BREAKDOWN_TOOLS).map(({ name, count }) => ({ name, count })),
    remaining: Math.max(0, sorted.length - MAX_BREAKDOWN_TOOLS),
  };
}

export function formatToolRunBreakdown(
  breakdown: ToolBreakdown | null | undefined,
  moreLabel = "",
): string {
  if (!breakdown) return "";
  const parts = breakdown.tools.map(({ name, count }) => `${name} x${count}`);
  if (breakdown.remaining > 0 && moreLabel) parts.push(moreLabel);
  return parts.join(", ");
}

export function groupToolRuns(activePath: ReadonlyArray<SessionEntry> = []): ToolRunRenderItem[] {
  const renderItems: ToolRunRenderItem[] = [];
  const completedCallIds = collectCompletedCallIds(activePath);

  for (let index = 0; index < activePath.length;) {
    const current = activePath[index];
    if (!current) break;
    if (analyzeToolRunEntry(current, completedCallIds) === null || !canStartToolRun(current)) {
      renderItems.push({ kind: "entry", entry: current });
      index += 1;
      continue;
    }

    const entries: SessionEntry[] = [];
    const toolNames: string[] = [];
    const toolCallIds: string[] = [];
    while (index < activePath.length) {
      const entryToolNames = analyzeToolRunEntry(activePath[index], completedCallIds);
      if (entryToolNames === null) break;
      const entry = activePath[index];
      if (!entry) break;
      entries.push(entry);
      toolNames.push(...entryToolNames);
      const currentEntry = activePath[index];
      if (currentEntry?.type === "message") {
        for (const block of contentBlocksFromUnknown(currentEntry.message?.content)) {
          if (block?.type === "toolCall" && block.id) toolCallIds.push(block.id);
        }
      }
      index += 1;
    }

    if (
      toolNames.length > 0 ||
      entries.some((entry) => analyzeToolRunEntry(entry, completedCallIds))
    ) {
      const metadata = activityMetadata(entries, toolCallIds);
      renderItems.push({
        kind: "group",
        entries,
        toolCount: toolNames.length,
        ...metadata,
        breakdown: buildToolBreakdown(toolNames),
        status: toolRunStatus(entries, toolCallIds, completedCallIds),
      });
    } else {
      renderItems.push(...entries.map((entry): ToolRunRenderItem => ({ kind: "entry", entry })));
    }
  }

  return renderItems;
}
