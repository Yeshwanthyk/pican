import { Effect, Schema } from "effect";
import { runPromise } from "../../../lib/runtime";
import {
  isUnknownRecord,
  type SessionEntry,
  type UnknownRecord,
} from "../../../session/data/session-types";

type ContextWindows = Record<string, number>;

interface ContextUsageApi {
  readonly listModels: (
    sessionId: string,
  ) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;
}

const ContextModelSchema = Schema.Struct({
  provider: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  modelId: Schema.optionalKey(Schema.String),
  contextWindow: Schema.optionalKey(Schema.Number),
});
type ContextModel = typeof ContextModelSchema.Type;

class ModelRequestError extends Schema.TaggedErrorClass<ModelRequestError>()(
  "ModelRequestError",
  {},
) {}

const ModelsResponseSchema = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(ContextModelSchema)),
});

const numberFrom = (record: UnknownRecord, key: string): number => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

export function buildContextWindows(models: readonly ContextModel[] = []): ContextWindows {
  const windows: ContextWindows = {};
  models.forEach((model) => {
    const provider = model.provider ?? "";
    const id = model.id ?? model.modelId ?? "";
    if (!id) return;
    windows[id.toLowerCase()] = model.contextWindow ?? 0;
    if (provider) {
      windows[`${provider}/${id}`.toLowerCase()] = model.contextWindow ?? 0;
    }
  });
  return windows;
}

export function getModelContextLimit(
  modelId: string,
  provider = "",
  contextWindows: Readonly<ContextWindows> = {},
): number {
  if (!modelId) return 128000;
  const id = modelId.toLowerCase();
  const prov = provider.toLowerCase();
  const providerLimit = prov ? contextWindows[`${prov}/${id}`] : undefined;
  if (providerLimit) return providerLimit;
  const modelLimit = contextWindows[id];
  if (modelLimit) return modelLimit;

  if (id.includes("deepseek")) return 1000000;
  if (
    id.includes("gemini-1.5-pro") ||
    id.includes("gemini-2.0-pro") ||
    id.includes("gemini-2.5-pro") ||
    id.includes("gemini-3.1-pro") ||
    id.includes("agy-gemini-pro")
  ) {
    return 1000000;
  }
  if (id.includes("gemini-")) return 1000000;
  if (id.includes("claude-") || id.includes("sonnet") || id.includes("opus")) return 200000;
  if (id.includes("gpt-5")) return 272000;
  if (
    id.includes("gpt-4") ||
    id.includes("gpt4") ||
    id.includes("gpt-3.5") ||
    id.includes("o1") ||
    id.includes("o3")
  )
    return 128000;
  if (
    id.includes("llama-3") ||
    id.includes("llama3") ||
    id.includes("qwen") ||
    id.includes("glm") ||
    id.includes("mimo")
  )
    return 128000;
  if (id.includes("llama-2") || id.includes("llama2")) return 4096;
  return 128000;
}

export function collectContextUsage(entries: readonly SessionEntry[] = []) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  entries.forEach((entry) => {
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !isUnknownRecord(message.usage)) return;
    inputTokens += numberFrom(message.usage, "input");
    outputTokens += numberFrom(message.usage, "output");
    cacheReadTokens += numberFrom(message.usage, "cacheRead");
    cacheWriteTokens += numberFrom(message.usage, "cacheWrite");
  });

  let contextTokens = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !isUnknownRecord(message.usage)) continue;
    contextTokens =
      numberFrom(message.usage, "totalTokens") ||
      numberFrom(message.usage, "input") +
        numberFrom(message.usage, "output") +
        numberFrom(message.usage, "cacheRead") +
        numberFrom(message.usage, "cacheWrite");
    break;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalIOTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    contextTokens,
  };
}

function splitModelLabel(label = "") {
  const [modelName = "", providerName = ""] = label.split(" @ ");
  return { modelName: modelName.trim(), providerName: providerName.trim() };
}

function formatTokensDetail(n: number) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString();
}

function formatLimit(n: number) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(0) + "k";
  return n.toLocaleString();
}

interface ContextUsageOptions {
  readonly documentImpl?: Document;
  readonly entries?: readonly SessionEntry[];
  readonly knownModelLabel?: string;
  readonly contextWindows?: Readonly<ContextWindows>;
  readonly positionPopover?: () => void;
}

export function updateContextUsage({
  documentImpl = document,
  entries = [],
  knownModelLabel = "",
  contextWindows = {},
  positionPopover = () => {},
}: ContextUsageOptions = {}): void {
  const el = documentImpl.getElementById("pi-chat-context-usage");
  if (!el) return;

  const usage = collectContextUsage(entries);
  if (usage.contextTokens <= 0 && usage.totalIOTokens <= 0) {
    el.style.display = "none";
    return;
  }

  const { modelName, providerName } = splitModelLabel(knownModelLabel);
  const limit = getModelContextLimit(modelName, providerName, contextWindows);
  const percent = Math.min(100, Math.max(0, Math.round((usage.contextTokens / limit) * 100)));

  el.querySelector(".pi-context-fill")?.setAttribute("stroke-dasharray", `${percent}, 100`);
  const textSpan = el.querySelector(".pi-context-text");
  if (textSpan) textSpan.textContent = `${percent}%`;

  const formatNumber = (num: number) => num.toLocaleString();
  el.setAttribute(
    "title",
    `Click for details (${formatNumber(usage.contextTokens)} / ${formatNumber(limit)} tokens used in context)`,
  );

  el.classList.remove("warning", "danger");
  if (percent >= 90) el.classList.add("danger");
  else if (percent >= 70) el.classList.add("warning");

  const popoverBox = documentImpl.getElementById("pi-chat-context-popover");
  const setText = (selector: string, value: string) => {
    const target = popoverBox?.querySelector(selector);
    if (target) target.textContent = value;
  };
  setText("#pi-popover-val-input", formatTokensDetail(usage.inputTokens));
  setText("#pi-popover-val-cache-read", formatTokensDetail(usage.cacheReadTokens));
  setText("#pi-popover-val-cache-write", formatTokensDetail(usage.cacheWriteTokens));
  setText("#pi-popover-val-output", formatTokensDetail(usage.outputTokens));
  setText("#pi-popover-val-total", formatTokensDetail(usage.totalIOTokens));
  setText(".pi-popover-used", formatTokensDetail(usage.contextTokens));
  setText(".pi-popover-limit", formatLimit(limit));

  const popoverBar = popoverBox?.querySelector<HTMLElement>(".pi-popover-progress-bar");
  if (popoverBar) popoverBar.style.width = `${percent}%`;

  if (popoverBox) {
    popoverBox.classList.remove("warning", "danger");
    if (percent >= 90) popoverBox.classList.add("danger");
    else if (percent >= 70) popoverBox.classList.add("warning");
    if (popoverBox.style.display !== "none") positionPopover();
  }

  el.style.display = "inline-flex";
}

interface ContextUsageControllerOptions {
  readonly documentImpl?: Document;
  readonly entries?: readonly SessionEntry[];
  readonly sessionId?: string;
  readonly chatApi?: ContextUsageApi;
  readonly getKnownModelLabel?: () => string;
  readonly positionPopover?: () => void;
}

export function createContextUsageController({
  documentImpl = document,
  entries = [],
  sessionId = "",
  chatApi,
  getKnownModelLabel = () => "",
  positionPopover = () => {},
}: ContextUsageControllerOptions = {}) {
  let contextWindows: ContextWindows = {};

  const update = () =>
    updateContextUsage({
      documentImpl,
      entries,
      knownModelLabel: getKnownModelLabel(),
      contextWindows,
      positionPopover,
    });

  if (chatApi) {
    const loadModels = Effect.tryPromise({
      try: () => chatApi.listModels(sessionId),
      catch: () => new ModelRequestError(),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.tryPromise({
              try: () => response.json(),
              catch: () => new ModelRequestError(),
            })
          : Effect.fail(new ModelRequestError()),
      ),
      Effect.flatMap((payload) => Schema.decodeUnknownEffect(ModelsResponseSchema)(payload)),
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (data) => {
          contextWindows = buildContextWindows(data.models ?? []);
          update();
        },
      }),
    );
    void runPromise(loadModels);
  }

  return {
    update,
    getContextWindows: () => contextWindows,
  };
}
