import {
  isUnknownRecord,
  type SessionEntry,
  type ToolCallInfo,
  type UnknownRecord,
} from "../data/session-types.js";
import { Match, Option } from "effect";

interface ToolResultLike {
  readonly details?: UnknownRecord;
}

interface HtmlDocument {
  createElement(tagName: string): { textContent: string | null; innerHTML: string };
}

export function shortenPath(p: unknown): string {
  if (typeof p !== "string") return "";
  if (p.startsWith("/Users/")) {
    const parts = p.split("/");
    if (parts.length > 2) return "~" + p.slice(("/Users/" + parts[2]).length);
  }
  if (p.startsWith("/home/")) {
    const parts = p.split("/");
    if (parts.length > 2) return "~" + p.slice(("/home/" + parts[2]).length);
  }
  return p;
}

export function formatToolCall(name: string, args: UnknownRecord = {}): string {
  const formatted = Match.value(name).pipe(
    Match.when("read", () => {
      const path = shortenPath(String(args.path || args.file_path || ""));
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let display = path;
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        const end = limit !== undefined ? start + limit - 1 : "";
        display += `:${start}${end ? `-${end}` : ""}`;
      }
      return `[read: ${display}]`;
    }),
    Match.when("write", () => `[write: ${shortenPath(String(args.path || args.file_path || ""))}]`),
    Match.when("edit", () => `[edit: ${shortenPath(String(args.path || args.file_path || ""))}]`),
    Match.when("bash", () => {
      const rawCmd = String(args.command || "");
      const cmd = rawCmd
        .replace(/[\n\t]/g, " ")
        .trim()
        .slice(0, 50);
      return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
    }),
    Match.when(
      "grep",
      () => `[grep: /${args.pattern || ""}/ in ${shortenPath(String(args.path || "."))}]`,
    ),
    Match.when(
      "find",
      () => `[find: ${args.pattern || ""} in ${shortenPath(String(args.path || "."))}]`,
    ),
    Match.when("ls", () => `[ls: ${shortenPath(String(args.path || "."))}]`),
    Match.when("TaskCreate", () => `[TaskCreate: ${String(args.subject || "")}]`),
    Match.when("TaskList", () => "[TaskList]"),
    Match.whenOr(
      "TaskUpdate",
      "TaskGet",
      "TaskClaim",
      "TaskOutput",
      "TaskStop",
      (toolName) => `[${toolName}: ${String(args.taskId ?? args.task_id ?? "")}]`,
    ),
    Match.when("TaskExecute", () => {
      const ids = Array.isArray(args.task_ids) ? args.task_ids.join(", ") : args.task_ids || "";
      return `[TaskExecute: ${String(ids)}]`;
    }),
    Match.when("subagent_spawn", () => `[subagent_spawn: ${String(args.title || args.id || "")}]`),
    Match.whenOr("subagent_wait", "subagent_cancel", (toolName) => {
      const ids = Array.isArray(args.ids) ? args.ids.join(", ") : args.id || args.ids || "";
      return `[${toolName}: ${String(ids)}]`;
    }),
    Match.when("subagent_check", () => `[subagent_check: ${String(args.id || "")}]`),
    Match.when("subagent_list", () => "[subagent_list]"),
    Match.when("workflow", () => {
      const label = args.name || args.runId || args.run_id || "";
      const status = args.status ? ` (${args.status})` : "";
      return `[workflow: ${String(label)}${status}]`;
    }),
    Match.option,
  );
  return Option.getOrElse(formatted, () => {
    const json = JSON.stringify(args);
    const preview = json.slice(0, 40);
    return `[${name}: ${preview}${json.length > 40 ? "..." : ""}]`;
  });
}

export function formatToolFoldSummary(
  name: string,
  args: UnknownRecord = {},
  result: ToolResultLike | null = null,
): string {
  const truncateInline = (value: unknown, maxLength: number): string => {
    const text = String(value ?? "")
      .replace(/[\n\t]/g, " ")
      .trim();
    return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
  };

  if (name === "bash") return truncateInline(args.command, 80);

  if (["read", "write", "edit", "ls"].includes(name)) {
    const path = shortenPath(String(args.file_path ?? args.path ?? (name === "ls" ? "." : "")));
    if (name !== "edit") return path;

    const patch = result?.details?.diff ?? result?.details?.patch;
    if (typeof patch !== "string") return path;
    const lines = patch.split("\n");
    const added = lines.filter((line) => /^\+(?!\+\+)/.test(line)).length;
    const removed = lines.filter((line) => /^-(?!--)/.test(line)).length;
    return `${path} (+${added} -${removed})`;
  }

  if (name.startsWith("Task") || name.startsWith("subagent_") || name === "workflow") {
    const formatted = formatToolCall(name, args).replace(/^\[|\]$/g, "");
    const prefix = `${name}: `;
    return formatted.startsWith(prefix) ? formatted.slice(prefix.length) : "";
  }

  return truncateInline(JSON.stringify(args) ?? "", 60);
}

export function escapeHtml(
  text: unknown,
  { documentImpl = globalThis.document }: { readonly documentImpl?: HtmlDocument } = {},
): string {
  if (documentImpl?.createElement) {
    const div = documentImpl.createElement("div");
    div.textContent = String(text ?? "");
    return div.innerHTML;
  }
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function truncate(value: unknown, maxLen = 100): string {
  const text = String(value ?? "");
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

interface TreeDisplayOptions {
  readonly extractContent?: (content: unknown) => string;
  readonly toolCallMap?: ReadonlyMap<string, ToolCallInfo>;
  readonly escapeHtmlImpl?: (text: unknown) => string;
}

export function getTreeNodeDisplayHtml(
  entry: Partial<SessionEntry>,
  label: string | null | undefined,
  { extractContent, toolCallMap = new Map(), escapeHtmlImpl = escapeHtml }: TreeDisplayOptions = {},
): string {
  const normalize = (value: unknown): string =>
    String(value ?? "")
      .replace(/[\n\t]/g, " ")
      .trim();
  const getContent =
    extractContent ?? ((content: unknown) => (typeof content === "string" ? content : ""));
  const labelHtml = label ? `<span class="tree-label">[${escapeHtmlImpl(label)}]</span> ` : "";

  const display = Match.value(entry.type).pipe(
    Match.when("message", () => {
      const msg = entry.message;
      if (!msg) return labelHtml + '<span class="tree-muted">[message]</span>';
      if (msg.role === "user") {
        const content = truncate(normalize(getContent(msg.content)));
        return labelHtml + `<span class="tree-role-user">user:</span> ${escapeHtmlImpl(content)}`;
      }
      if (msg.role === "assistant") {
        const textContent = truncate(normalize(getContent(msg.content)));
        if (textContent)
          return (
            labelHtml +
            `<span class="tree-role-assistant">assistant:</span> ${escapeHtmlImpl(textContent)}`
          );
        if (msg.stopReason === "aborted")
          return (
            labelHtml +
            `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(aborted)</span>`
          );
        if (msg.errorMessage)
          return (
            labelHtml +
            `<span class="tree-role-assistant">assistant:</span> <span class="tree-error">${escapeHtmlImpl(truncate(msg.errorMessage))}</span>`
          );
        return (
          labelHtml +
          `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(no text)</span>`
        );
      }
      if (msg.role === "toolResult") {
        const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : null;
        if (toolCall)
          return (
            labelHtml +
            `<span class="tree-role-tool">${escapeHtmlImpl(formatToolCall(typeof toolCall.name === "string" ? toolCall.name : "tool", isUnknownRecord(toolCall.arguments) ? toolCall.arguments : {}))}</span>`
          );
        return labelHtml + `<span class="tree-role-tool">[${msg.toolName || "tool"}]</span>`;
      }
      if (msg.role === "bashExecution") {
        const cmd = truncate(normalize(msg.command || ""));
        return labelHtml + `<span class="tree-role-tool">[bash]:</span> ${escapeHtmlImpl(cmd)}`;
      }
      return labelHtml + `<span class="tree-muted">[${msg.role}]</span>`;
    }),
    Match.when(
      "compaction",
      () =>
        labelHtml +
        `<span class="tree-compaction">[compaction: ${Math.round((entry.tokensBefore ?? 0) / 1000)}k tokens]</span>`,
    ),
    Match.when("branch_summary", () => {
      const summary = truncate(normalize(entry.summary || ""));
      return (
        labelHtml +
        `<span class="tree-branch-summary">[branch summary]:</span> ${escapeHtmlImpl(summary)}`
      );
    }),
    Match.when("custom_message", () => {
      const content = typeof entry.content === "string" ? entry.content : getContent(entry.content);
      return (
        labelHtml +
        `<span class="tree-custom">[${escapeHtmlImpl(entry.customType)}]:</span> ${escapeHtmlImpl(truncate(normalize(content)))}`
      );
    }),
    Match.when(
      "model_change",
      () => labelHtml + `<span class="tree-muted">[model: ${entry.modelId}]</span>`,
    ),
    Match.when(
      "thinking_level_change",
      () => labelHtml + `<span class="tree-muted">[thinking: ${entry.thinkingLevel}]</span>`,
    ),
    Match.option,
  );
  return Option.getOrElse(
    display,
    () => labelHtml + `<span class="tree-muted">[${entry.type}]</span>`,
  );
}
