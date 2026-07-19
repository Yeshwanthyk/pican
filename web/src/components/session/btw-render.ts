import { marked } from "marked";
import { Effect } from "effect";
import { runSync } from "../../lib/runtime";
import { formatToolCall } from "../../session/render/session-format.js";
import {
  contentBlockFromUnknown,
  isUnknownRecord,
  type SessionEntry,
} from "../../session/data/session-types";

export function escapeBtwText(
  text: unknown,
  { documentImpl = document }: { documentImpl?: Document } = {},
): string {
  const node = documentImpl.createElement("div");
  node.textContent = String(text == null ? "" : text);
  return node.innerHTML;
}

export function createBtwMarkdownRenderer({
  documentImpl = document,
  markedImpl = marked,
}: { documentImpl?: Document; markedImpl?: typeof marked } = {}): (text: unknown) => string {
  return (text) =>
    runSync(
      Effect.try({
        try: () => markedImpl.parse(String(text == null ? "" : text), { async: false }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(escapeBtwText(text, { documentImpl })))),
    );
}

export function btwContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((value) => {
        const block = contentBlockFromUnknown(value);
        return block?.type === "text" ? [block] : [];
      })
      .map((block) => String(block.text ?? ""))
      .join("");
  }
  return "";
}

export function renderBtwEntryParts(
  entry: SessionEntry | null | undefined,
  {
    toHtml = createBtwMarkdownRenderer(),
    formatToolCallImpl = formatToolCall,
  }: {
    toHtml?: (text: unknown) => string;
    formatToolCallImpl?: (name: string, args: Record<string, unknown>) => string;
  } = {},
): {
  role: "user" | "assistant";
  parts: Array<{ kind: "md"; html: string } | { kind: "tool"; text: string }>;
} | null {
  if (!entry || entry.type !== "message" || !entry.message) return null;
  const msg = entry.message;
  if (msg.role === "user") {
    const text = btwContentText(msg.content).trim();
    if (!text) return null;
    return { role: "user", parts: [{ kind: "md", html: toHtml(text) }] };
  }
  if (msg.role === "assistant") {
    const parts: Array<{ kind: "md"; html: string } | { kind: "tool"; text: string }> = [];
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    blocks.forEach((block) => {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        parts.push({ kind: "md", html: toHtml(block.text) });
      } else if (block.type === "toolCall" && typeof block.name === "string") {
        const args = isUnknownRecord(block.arguments) ? block.arguments : {};
        parts.push({ kind: "tool", text: formatToolCallImpl(block.name, args) });
      }
    });
    if (parts.length === 0 && typeof msg.content === "string" && msg.content.trim()) {
      parts.push({ kind: "md", html: toHtml(msg.content) });
    }
    if (parts.length === 0) return null;
    return { role: "assistant", parts };
  }
  if (msg.role === "bashExecution" && msg.command) {
    return { role: "assistant", parts: [{ kind: "tool", text: `$ ${msg.command}` }] };
  }
  return null;
}
