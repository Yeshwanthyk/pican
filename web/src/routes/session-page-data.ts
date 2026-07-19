import { Effect, Schema } from "effect";
import { DecodeError, HttpError } from "../lib/errors";
import type { FetchLike } from "../lib/http";
import * as Http from "../lib/http";
import { runPromise, runSync } from "../lib/runtime";
import type { SessionEntry, SessionMessage, UnknownRecord } from "../session/data/session-types";
import { decodeBase64JSON } from "../session/data/session-data";
import { t } from "../shared/strings";
import { consumeSessionPrefetch } from "./session-prefetch";

interface TextDecoderConstructor {
  new (label?: string): { decode(input?: AllowSharedBufferSource): string };
}

interface TextEncoderConstructor {
  new (): { encode(input?: string): Uint8Array };
}

interface SessionDocument {
  getElementById(id: string): { readonly textContent: string | null } | null;
}

interface CodecOptions {
  readonly btoaImpl?: (value: string) => string;
  readonly TextEncoderImpl?: TextEncoderConstructor;
}

interface BootstrapOptions {
  readonly documentImpl?: SessionDocument;
  readonly atobImpl?: (value: string) => string;
  readonly TextDecoderImpl?: TextDecoderConstructor;
}

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const SessionPageDataSchema = Schema.StructWithRest(
  Schema.Struct({
    header: Schema.optionalKey(UnknownRecordSchema),
    entries: Schema.optionalKey(Schema.Array(UnknownRecordSchema)),
    name: Schema.optionalKey(Schema.String),
    runtime: Schema.optionalKey(Schema.String),
    Runtime: Schema.optionalKey(Schema.String),
    nativeId: Schema.optionalKey(Schema.String),
    NativeID: Schema.optionalKey(Schema.String),
    sessionUUID: Schema.optionalKey(Schema.String),
    SessionUUID: Schema.optionalKey(Schema.String),
    total: Schema.optionalKey(Schema.Number),
    from: Schema.optionalKey(Schema.Number),
    chatAvailable: Schema.optionalKey(Schema.Boolean),
    ChatAvailable: Schema.optionalKey(Schema.Boolean),
    chatDisabledReason: Schema.optionalKey(Schema.String),
    ChatDisabledReason: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    Model: Schema.optionalKey(Schema.String),
    modelProvider: Schema.optionalKey(Schema.String),
    ModelProvider: Schema.optionalKey(Schema.String),
  }),
  [UnknownRecordSchema],
);
export type SessionPageData = typeof SessionPageDataSchema.Type;

const BootstrapSchema = Schema.Struct({
  id: Schema.String,
  data: SessionPageDataSchema,
  scratchpad: Schema.optionalKey(Schema.String),
});
export type SessionBootstrap = typeof BootstrapSchema.Type;
const decodeBootstrap = Schema.decodeUnknownEffect(BootstrapSchema);
const isHttpError = Schema.is(HttpError);

class SessionPageError extends Schema.TaggedErrorClass<SessionPageError>()("SessionPageError", {
  message: Schema.String,
}) {}

export interface SessionPageState {
  readonly sessionId: string;
  readonly title: string;
  readonly runtime: string;
  readonly nativeId: string;
  readonly sessionUUID: string;
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly cwd: string;
  readonly scratchpad: string;
  readonly chatAvailable: boolean;
  readonly chatDisabledReason: string;
  readonly modelLabel: string;
  readonly payloadBase64: string;
}

interface LooseSessionEntry extends UnknownRecord {
  readonly id?: string;
  readonly type?: string;
  readonly message?: SessionMessage;
}

interface BuildStateOptions extends CodecOptions {
  readonly sessionId: string;
  readonly data: SessionPageData;
  readonly scratchpad?: string;
}

interface LoadStateOptions extends CodecOptions, BootstrapOptions {
  readonly locationSearch?: string;
  readonly fetchImpl?: FetchLike;
}

export function readSessionBootstrap({
  documentImpl,
  atobImpl,
  TextDecoderImpl,
}: BootstrapOptions = {}): SessionBootstrap | null {
  const doc = documentImpl ?? (typeof document === "undefined" ? undefined : document);
  const raw = doc?.getElementById("pican-session-bootstrap")?.textContent?.trim() ?? "";
  if (!raw) return null;
  return runSync(
    Effect.try({
      try: () => decodeBase64JSON(raw, { atobImpl, TextDecoderImpl }),
      catch: () => new DecodeError({ url: "#pican-session-bootstrap", issue: "invalid bootstrap" }),
    }).pipe(
      Effect.flatMap(decodeBootstrap),
      Effect.catch(() => Effect.succeed(null)),
    ),
  );
}

export function encodePayload(
  payload: unknown,
  { btoaImpl = globalThis.btoa, TextEncoderImpl = globalThis.TextEncoder }: CodecOptions = {},
): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoderImpl().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoaImpl(binary);
}

export function newestLeaf(entries: ReadonlyArray<LooseSessionEntry | null> = []): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.id && entry.type !== "session" && entry.type !== "label") return entry.id;
  }
  return "";
}

const contentPartText = (part: unknown): string => {
  if (typeof part === "string") return part;
  if (typeof part !== "object" || part === null || Array.isArray(part)) return "";
  const text = (part as UnknownRecord).text;
  return typeof text === "string" ? text : "";
};

export function firstMessageStub(entries: ReadonlyArray<LooseSessionEntry> = []): string {
  const entry = entries.find((item) => item.type === "message" && item.message?.role === "user");
  const content = Array.isArray(entry?.message?.content)
    ? entry.message.content.map(contentPartText).join("")
    : entry?.message?.content;
  if (!content) return "";
  const text = String(content)
    .slice(0, 500)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<div class="user-message" aria-hidden="true"><div class="markdown-content"><p>${text}</p></div></div>`;
}

const ScratchpadSchema = Schema.Struct({ content: Schema.optionalKey(Schema.String) });

export function loadScratchpad(
  projectPath: string,
  { fetchImpl = globalThis.fetch }: { readonly fetchImpl?: FetchLike } = {},
): Promise<string> {
  if (!projectPath) return Promise.resolve("");
  return runPromise(
    Http.get(`/api/scratchpad?project=${encodeURIComponent(projectPath)}`, ScratchpadSchema, {
      fetchImpl,
    }).pipe(
      Effect.map(({ content }) => content ?? ""),
      Effect.catch(() => Effect.succeed("")),
    ),
  );
}

export function normalizeSessionRuntime(
  data: Partial<SessionPageData> = {},
  header: UnknownRecord = data.header ?? {},
) {
  const runtime = String(data.runtime || data.Runtime || header.runtime || "pi").toLowerCase();
  return {
    runtime,
    nativeId: String(data.nativeId || data.NativeID || header.nativeId || ""),
    sessionUUID: String(
      data.sessionUUID || data.SessionUUID || header.sessionUUID || header.id || "",
    ),
  };
}

export function buildSessionPageState({
  sessionId,
  data,
  scratchpad = "",
  btoaImpl,
  TextEncoderImpl,
}: BuildStateOptions): SessionPageState {
  const entries: Array<SessionEntry> = Array.isArray(data.entries)
    ? data.entries.map((entry) => ({ ...entry, id: typeof entry.id === "string" ? entry.id : "" }))
    : [];
  const header = data.header ?? {};
  const { runtime, nativeId, sessionUUID } = normalizeSessionRuntime(data, header);
  const normalizedHeader: UnknownRecord = { ...header, runtime };
  if (nativeId) normalizedHeader.nativeId = nativeId;
  const cwd = typeof header.cwd === "string" ? header.cwd : "";
  const title = data.name || sessionId;
  const leafId = newestLeaf(entries);
  const total = Number.isInteger(data.total) ? (data.total ?? entries.length) : entries.length;
  const from = Number.isInteger(data.from) ? (data.from ?? 0) : 0;
  const chatAvailable = data.chatAvailable ?? data.ChatAvailable ?? true;
  let chatDisabledReason = data.chatDisabledReason || data.ChatDisabledReason || "";
  if (!chatAvailable && !chatDisabledReason) {
    chatDisabledReason =
      "This session can be viewed, but chat is disabled because its working directory no longer exists.";
  }
  const model = data.model || data.Model || "";
  const provider = data.modelProvider || data.ModelProvider || "";
  return {
    sessionId,
    title,
    runtime,
    nativeId,
    sessionUUID,
    entries,
    cwd,
    scratchpad,
    chatAvailable,
    chatDisabledReason,
    modelLabel: model && provider ? `${model} @ ${provider}` : model,
    payloadBase64: encodePayload(
      {
        header: normalizedHeader,
        entries,
        name: title,
        leafId,
        systemPrompt: null,
        tools: null,
        renderedTools: null,
        total,
        from,
        truncated: entries.length < total,
      },
      { btoaImpl, TextEncoderImpl },
    ),
  };
}

export function loadSessionPageState({
  locationSearch = "",
  fetchImpl = globalThis.fetch,
  btoaImpl,
  TextEncoderImpl,
  documentImpl,
  atobImpl,
  TextDecoderImpl,
}: LoadStateOptions = {}): Promise<SessionPageState> {
  const sessionId = new URLSearchParams(locationSearch).get("id") || "";
  if (!sessionId)
    return runPromise(Effect.fail(new SessionPageError({ message: t("session.missingId") })));

  const boot = readSessionBootstrap({ documentImpl, atobImpl, TextDecoderImpl });
  if (boot?.id === sessionId) {
    return Promise.resolve(
      buildSessionPageState({
        sessionId,
        data: boot.data,
        scratchpad: boot.scratchpad || "",
        btoaImpl,
        TextEncoderImpl,
      }),
    );
  }

  const prefetched = consumeSessionPrefetch(sessionId);
  const prefetchedEffect = prefetched
    ? Effect.tryPromise({
        try: () => prefetched,
        catch: () => new DecodeError({ url: "/api/session", issue: "prefetch failed" }),
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    : Effect.succeed(undefined);
  const url = `/api/session?id=${encodeURIComponent(sessionId)}&paginate=1`;
  const effect = prefetchedEffect.pipe(
    Effect.flatMap((prefetchedData) =>
      prefetchedData === undefined
        ? Http.get(url, Schema.Unknown, { fetchImpl })
        : Effect.succeed(prefetchedData),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(SessionPageDataSchema)),
    Effect.mapError(
      (error) =>
        new SessionPageError({
          message:
            isHttpError(error) && error.status === 404
              ? t("session.notFound")
              : t("session.loadFailed"),
        }),
    ),
    Effect.map((data) =>
      buildSessionPageState({
        sessionId,
        data,
        scratchpad: "",
        btoaImpl,
        TextEncoderImpl,
      }),
    ),
  );
  return runPromise(effect);
}
