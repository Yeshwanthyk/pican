import { Effect, Schema } from "effect";
import { DecodeError } from "../../lib/errors.js";
import { runSync } from "../../lib/runtime";
import {
  contentBlockFromUnknown,
  contentBlocksFromUnknown,
  isUnknownRecord,
  type SessionDataShape,
  type SessionEntry,
  type SessionPayload,
  type ToolCallInfo,
  type UnknownRecord,
} from "./session-types";

interface TextDecoderConstructor {
  new (label?: string): { decode(input?: AllowSharedBufferSource): string };
}

interface DecodeOptions {
  readonly atobImpl?: (value: string) => string;
  readonly TextDecoderImpl?: TextDecoderConstructor;
}

interface SessionDocument {
  getElementById(id: string): { readonly textContent: string | null } | null;
  querySelector(selector: string): { readonly content?: string } | null;
}

interface SessionWindow {
  readonly location?: { readonly search?: string };
}

interface SessionDomOptions extends DecodeOptions {
  readonly documentImpl?: SessionDocument;
  readonly windowImpl?: SessionWindow;
}

const JsonObjectSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonObject = Schema.decodeUnknownEffect(JsonObjectSchema);
const normalizeEntry = (value: unknown): SessionEntry | null => {
  if (!isUnknownRecord(value) || typeof value.id !== "string") return null;
  const entry: SessionEntry = { ...value, id: value.id };
  if (isUnknownRecord(value.message)) {
    entry.message = {
      ...value.message,
      content:
        typeof value.message.content === "string"
          ? value.message.content
          : contentBlocksFromUnknown(value.message.content),
    };
  }
  if (isUnknownRecord(value.details)) entry.details = { ...value.details };
  return entry;
};

const normalizePayload = (value: UnknownRecord): SessionPayload => {
  const entries = Array.isArray(value.entries)
    ? value.entries.flatMap((entry) => {
        const normalized = normalizeEntry(entry);
        return normalized ? [normalized] : [];
      })
    : undefined;
  return {
    ...value,
    header: isUnknownRecord(value.header) ? value.header : undefined,
    entries,
    leafId: typeof value.leafId === "string" ? value.leafId : undefined,
    total: typeof value.total === "number" ? value.total : undefined,
    from: typeof value.from === "number" ? value.from : undefined,
    truncated: typeof value.truncated === "boolean" ? value.truncated : undefined,
    projectionMode: typeof value.projectionMode === "string" ? value.projectionMode : undefined,
    runtimeLabel: typeof value.runtimeLabel === "string" ? value.runtimeLabel : undefined,
    resumeCommand: typeof value.resumeCommand === "string" ? value.resumeCommand : undefined,
    capabilities: isUnknownRecord(value.capabilities) ? value.capabilities : undefined,
  };
};

export function decodeBase64JSON(
  base64: string,
  { atobImpl = globalThis.atob, TextDecoderImpl = globalThis.TextDecoder }: DecodeOptions = {},
): UnknownRecord {
  const decoded = Effect.try({
    try: () => {
      const binary = atobImpl(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoderImpl("utf-8").decode(bytes);
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap(decodeJsonObject),
    Effect.catch((issue) =>
      Effect.fail(new DecodeError({ url: "#session-data", issue: String(issue) })),
    ),
  );
  return runSync(decoded);
}

export function readSessionPayload({
  documentImpl = document,
  atobImpl = globalThis.atob,
  TextDecoderImpl = globalThis.TextDecoder,
}: SessionDomOptions = {}): UnknownRecord {
  const element = documentImpl.getElementById("session-data");
  if (!element) {
    return runSync(
      Effect.fail(
        new DecodeError({ url: "#session-data", issue: "missing #session-data element" }),
      ),
    );
  }
  return decodeBase64JSON(element.textContent || "", { atobImpl, TextDecoderImpl });
}

export function getSessionSearchParams({
  documentImpl = document,
  windowImpl = window,
}: SessionDomOptions = {}): URLSearchParams {
  const injectedParams = documentImpl.querySelector('meta[name="pican-url-params"]');
  const searchString = injectedParams?.content
    ? injectedParams.content
    : (windowImpl.location?.search || "").replace(/^\?/, "");
  return new URLSearchParams(searchString);
}

export function buildSessionLookups(entries: ReadonlyArray<SessionEntry> = []) {
  const byId = new Map<string, SessionEntry>();
  const toolCallMap = new Map<string, ToolCallInfo>();
  const labelMap = new Map<string, string>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const candidate of content) {
          const block = contentBlockFromUnknown(candidate);
          if (block?.type === "toolCall" && block.id) {
            toolCallMap.set(block.id, { name: block.name, arguments: block.arguments });
          }
        }
      }
    }
    if (entry.type === "label" && entry.targetId) {
      if (entry.label) labelMap.set(entry.targetId, entry.label);
      else labelMap.delete(entry.targetId);
    }
  }
  return { byId, toolCallMap, labelMap };
}

export function createSessionDataModel(
  rawPayload: SessionPayload | UnknownRecord,
  params = new URLSearchParams(),
) {
  const payload = normalizePayload(rawPayload);
  const header = payload.header || {};
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const defaultLeafId = payload.leafId || "";
  const urlLeafId = params.get("leafId");
  const urlTargetId = params.get("targetId");
  const total = Number.isInteger(payload.total)
    ? (payload.total ?? entries.length)
    : entries.length;
  const from = Number.isInteger(payload.from) ? (payload.from ?? 0) : 0;
  const truncated = Boolean(payload.truncated) || from > 0 || entries.length < total;
  return {
    payload,
    params,
    header,
    entries,
    defaultLeafId,
    leafId: urlLeafId || defaultLeafId,
    urlLeafId,
    urlTargetId,
    systemPrompt: payload.systemPrompt ?? null,
    tools: payload.tools ?? null,
    renderedTools: payload.renderedTools ?? null,
    total,
    from,
    truncated,
    projectionMode: payload.projectionMode,
    ...buildSessionLookups(entries),
  } satisfies SessionDataShape & {
    readonly payload: SessionPayload;
    readonly params: URLSearchParams;
    readonly byId: Map<string, SessionEntry>;
    readonly toolCallMap: Map<string, ToolCallInfo>;
    readonly labelMap: Map<string, string>;
  };
}

export function loadSessionData(options: SessionDomOptions = {}) {
  return createSessionDataModel(readSessionPayload(options), getSessionSearchParams(options));
}
