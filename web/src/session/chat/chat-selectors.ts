export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export interface ModelOption {
  readonly provider?: string | null;
  readonly id?: string | null;
  readonly modelId?: string | null;
  readonly name?: string | null;
  readonly isScoped?: boolean;
  readonly scoped?: boolean;
  readonly scope?: unknown;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null | undefined>>;
}

interface SessionEntry {
  readonly type?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly message?: {
    readonly role?: string;
    readonly provider?: string;
    readonly model?: string;
  };
}

export function isScopedModel(model: ModelOption | null | undefined): boolean {
  return !!(model?.isScoped || model?.scoped || model?.scope);
}

export function groupModelsByProvider(
  models: ReadonlyArray<ModelOption>,
  filter = "",
): Record<string, ModelOption[]> {
  const q = filter.toLowerCase();
  const byProvider: Record<string, ModelOption[]> = {};
  models.forEach((model) => {
    if (q) {
      const name = (model.name || model.id || model.modelId || "").toLowerCase();
      const provider = (model.provider || "").toLowerCase();
      if (!name.includes(q) && !provider.includes(q)) return;
    }
    const provider = model.provider || "unknown";
    const group = byProvider[provider] ?? [];
    group.push(model);
    byProvider[provider] = group;
  });
  return byProvider;
}

export function findModel(
  models: ReadonlyArray<ModelOption>,
  provider: string,
  modelId: string,
): ModelOption | undefined {
  return models.find(
    (model) =>
      (model.provider || "") === provider &&
      ((model.id || "") === modelId || (model.modelId || "") === modelId),
  );
}

export function detectCurrentModel(entries: ReadonlyArray<SessionEntry>): {
  provider: string;
  modelId: string;
} {
  const modelChanges = entries.filter((entry) => entry.type === "model_change");
  if (modelChanges.length > 0) {
    const latest = modelChanges[modelChanges.length - 1];
    return { provider: latest?.provider || "", modelId: latest?.modelId || "" };
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry?.type === "message" &&
      entry.message &&
      entry.message.role === "assistant" &&
      entry.message.model
    ) {
      return { provider: entry.message.provider || "", modelId: entry.message.model || "" };
    }
  }
  return { provider: "", modelId: "" };
}

export function supportedThinkingLevels(
  model: ModelOption | null | undefined,
  levels: ReadonlyArray<string> = THINKING_LEVELS,
): ReadonlyArray<string> {
  if (!model) return levels;
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap || {};
  return levels.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

export function detectCurrentThinkingLevel(entries: ReadonlyArray<SessionEntry>): string {
  const changes = entries.filter((entry) => entry.type === "thinking_level_change");
  const latest = changes[changes.length - 1];
  return latest?.thinkingLevel || "";
}

export function modelDisplayLabel(model: ModelOption | null | undefined, fallbackId = ""): string {
  const id = model?.name || model?.id || model?.modelId || fallbackId;
  return id + (model?.provider ? " @ " + model.provider : "");
}
