// Pure session statistics + token formatting, shared by the live app and the
// static export. Extracted from session-header-renderer.js during the Svelte
// migration so the header card can be a component while the math stays a
// framework-free, unit-tested function. See docs/dev/svelte-migration-plan.md.

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return (count / 1000).toFixed(1) + "k";
  if (count < 1000000) return Math.round(count / 1000) + "k";
  return (count / 1000000).toFixed(1) + "M";
}

export function computeSessionStats(
  entryList: ReadonlyArray<Partial<SessionEntry>> = [],
): SessionStats {
  let userMessages = 0,
    assistantMessages = 0,
    toolResults = 0;
  let customMessages = 0,
    compactions = 0,
    branchSummaries = 0,
    toolCalls = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = new Set<string>();

  for (const entry of entryList) {
    if (entry.type === "message") {
      const msg = entry.message;
      if (!msg) continue;
      if (msg.role === "user") userMessages++;
      if (msg.role === "assistant") {
        assistantMessages++;
        if (msg.model) models.add(msg.provider ? `${msg.provider}/${msg.model}` : msg.model);
        if (msg.usage) {
          tokens.input += numberField(msg.usage, "input");
          tokens.output += numberField(msg.usage, "output");
          tokens.cacheRead += numberField(msg.usage, "cacheRead");
          tokens.cacheWrite += numberField(msg.usage, "cacheWrite");
          if (isUnknownRecord(msg.usage.cost)) {
            cost.input += numberField(msg.usage.cost, "input");
            cost.output += numberField(msg.usage.cost, "output");
            cost.cacheRead += numberField(msg.usage.cost, "cacheRead");
            cost.cacheWrite += numberField(msg.usage.cost, "cacheWrite");
          }
        }
        toolCalls += contentBlocksFromUnknown(msg.content).filter(
          (block) => block.type === "toolCall",
        ).length;
      }
      if (msg.role === "toolResult") toolResults++;
    } else if (entry.type === "model_change") {
      if (entry.modelId)
        models.add(entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId);
    } else if (entry.type === "compaction") {
      compactions++;
    } else if (entry.type === "branch_summary") {
      branchSummaries++;
    } else if (entry.type === "custom_message") {
      customMessages++;
    }
  }

  return {
    userMessages,
    assistantMessages,
    toolResults,
    customMessages,
    compactions,
    branchSummaries,
    toolCalls,
    tokens,
    cost,
    models: Array.from(models),
  };
}

// Pre-formatted summary strings used by the header card (kept here so they are
// unit-testable and identical between live + export).
export function summarizeSessionStats(stats: SessionStats) {
  const totalCost =
    stats.cost.input + stats.cost.output + stats.cost.cacheRead + stats.cost.cacheWrite;

  const tokenParts: string[] = [];
  if (stats.tokens.input) tokenParts.push(`↑${formatTokens(stats.tokens.input)}`);
  if (stats.tokens.output) tokenParts.push(`↓${formatTokens(stats.tokens.output)}`);
  if (stats.tokens.cacheRead) tokenParts.push(`R${formatTokens(stats.tokens.cacheRead)}`);
  if (stats.tokens.cacheWrite) tokenParts.push(`W${formatTokens(stats.tokens.cacheWrite)}`);

  const msgParts: string[] = [];
  if (stats.userMessages) msgParts.push(`${stats.userMessages} user`);
  if (stats.assistantMessages) msgParts.push(`${stats.assistantMessages} assistant`);
  if (stats.toolResults) msgParts.push(`${stats.toolResults} tool results`);
  if (stats.customMessages) msgParts.push(`${stats.customMessages} custom`);
  if (stats.compactions) msgParts.push(`${stats.compactions} compactions`);
  if (stats.branchSummaries) msgParts.push(`${stats.branchSummaries} branch summaries`);

  return {
    tokensText: tokenParts.join(" ") || "0",
    messagesText: msgParts.join(", ") || "0",
    modelsText: stats.models.join(", ") || "unknown",
    costText: `$${totalCost.toFixed(3)}`,
    toolCalls: stats.toolCalls,
  };
}
import {
  contentBlocksFromUnknown,
  isUnknownRecord,
  type SessionEntry,
} from "../data/session-types.js";

export interface NumericBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionStats {
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  customMessages: number;
  compactions: number;
  branchSummaries: number;
  toolCalls: number;
  tokens: NumericBreakdown;
  cost: NumericBreakdown;
  models: string[];
}

const numberField = (record: Record<string, unknown>, key: string): number =>
  typeof record[key] === "number" ? record[key] : 0;
