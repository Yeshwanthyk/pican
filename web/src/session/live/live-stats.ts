import {
  contentBlocksFromUnknown,
  isUnknownRecord,
  type SessionEntry,
} from "../data/session-types.js";

const numberField = (record: Record<string, unknown>, key: string): number =>
  typeof record[key] === "number" ? record[key] : 0;

export function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  if (n < 1000000) return Math.round(n / 1000) + "k";
  return (n / 1000000).toFixed(1) + "M";
}

export function computeLiveStats(entries: ReadonlyArray<Partial<SessionEntry>> = []) {
  const stats = {
    user: 0,
    assistant: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    models: new Set<string>(),
  };
  entries.forEach((entry) => {
    if (entry.type !== "message" || !entry.message) return;
    const message = entry.message;
    if (message.role === "user") stats.user++;
    if (message.role === "assistant") {
      stats.assistant++;
      if (message.model)
        stats.models.add(message.provider ? message.provider + "/" + message.model : message.model);
      if (message.usage) {
        stats.tokens.input += numberField(message.usage, "input");
        stats.tokens.output += numberField(message.usage, "output");
        stats.tokens.cacheRead += numberField(message.usage, "cacheRead");
        stats.tokens.cacheWrite += numberField(message.usage, "cacheWrite");
        if (isUnknownRecord(message.usage.cost)) {
          stats.cost.input += numberField(message.usage.cost, "input");
          stats.cost.output += numberField(message.usage.cost, "output");
          stats.cost.cacheRead += numberField(message.usage.cost, "cacheRead");
          stats.cost.cacheWrite += numberField(message.usage.cost, "cacheWrite");
        }
      }
      stats.toolCalls += contentBlocksFromUnknown(message.content).filter(
        (block) => block.type === "toolCall",
      ).length;
    }
  });
  return stats;
}

export function updateStatsDom(
  entries: ReadonlyArray<Partial<SessionEntry>>,
  { documentImpl = document }: { readonly documentImpl?: Document } = {},
): boolean {
  const stats = computeLiveStats(entries);
  const totalCost =
    stats.cost.input + stats.cost.output + stats.cost.cacheRead + stats.cost.cacheWrite;
  const headerInfo = documentImpl.querySelector(".header-info");
  if (!headerInfo) return false;

  const messageParts: string[] = [];
  if (stats.user) messageParts.push(stats.user + " user");
  if (stats.assistant) messageParts.push(stats.assistant + " assistant");

  headerInfo.querySelectorAll(".info-item").forEach((row) => {
    const label = row.querySelector(".info-label");
    const value = row.querySelector(".info-value");
    if (!label || !value) return;
    const text = label.textContent;
    if (text?.includes("Messages:")) value.textContent = messageParts.join(", ") || "0";
    if (text?.includes("Tool Calls:")) value.textContent = String(stats.toolCalls);
    if (text?.includes("Models:"))
      value.textContent = Array.from(stats.models).join(", ") || "unknown";
    if (text?.includes("Tokens:")) {
      const tokenParts: string[] = [];
      if (stats.tokens.input) tokenParts.push("↑" + formatTokens(stats.tokens.input));
      if (stats.tokens.output) tokenParts.push("↓" + formatTokens(stats.tokens.output));
      if (stats.tokens.cacheRead) tokenParts.push("R" + formatTokens(stats.tokens.cacheRead));
      if (stats.tokens.cacheWrite) tokenParts.push("W" + formatTokens(stats.tokens.cacheWrite));
      value.textContent = tokenParts.join(" ") || "0";
    }
    if (text?.includes("Cost:")) value.textContent = "$" + totalCost.toFixed(3);
  });
  return true;
}
