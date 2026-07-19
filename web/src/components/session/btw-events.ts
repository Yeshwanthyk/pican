import { Effect, Option, Schema } from "effect";
import { runSync } from "../../lib/runtime";

type EventSourceConstructor = new (url: string) => EventSource;

interface BtwEventOptions {
  readonly EventSourceImpl?: EventSourceConstructor | null;
}

const ChatPreviewSchema = Schema.Struct({
  content: Schema.optionalKey(Schema.String),
  done: Schema.optionalKey(Schema.Boolean),
});
export type BtwChatPreview = typeof ChatPreviewSchema.Type;
const decodeChatPreview = Schema.decodeUnknownOption(Schema.fromJsonString(ChatPreviewSchema));
const BtwChangedSchema = Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) });
const decodeBtwChanged = Schema.decodeUnknownOption(Schema.fromJsonString(BtwChangedSchema));

export function createBtwEventSource(
  topic: string,
  { EventSourceImpl = EventSource }: BtwEventOptions = {},
): EventSource {
  if (EventSourceImpl === null) return new EventSource("/events?id=" + encodeURIComponent(topic));
  return new EventSourceImpl("/events?id=" + encodeURIComponent(topic));
}

export function setupBtwSessionEvents({
  sessionId = "",
  EventSourceImpl = typeof EventSource !== "undefined" ? EventSource : null,
  onReload = () => undefined,
  onChatPreview = () => undefined,
}: BtwEventOptions & {
  readonly sessionId?: string;
  readonly onReload?: () => void;
  readonly onChatPreview?: (payload: BtwChatPreview) => void;
} = {}): EventSource | null {
  if (!sessionId || !EventSourceImpl) return null;
  const source = createBtwEventSource(sessionId, { EventSourceImpl });
  source.onmessage = (event) => {
    if (event.data === "reload") onReload();
  };
  source.addEventListener("chat-preview", (event) => {
    const payload = decodeChatPreview(event.data);
    if (Option.isSome(payload)) onChatPreview(payload.value);
  });
  source.onerror = () => undefined;
  return source;
}

export function setupBtwParentEvents({
  parentTopic = "",
  EventSourceImpl = typeof EventSource !== "undefined" ? EventSource : null,
  onChanged = () => undefined,
}: BtwEventOptions & {
  readonly parentTopic?: string;
  readonly onChanged?: (sessionId: string) => void;
} = {}): EventSource | null {
  if (!parentTopic || !EventSourceImpl) return null;
  const source = createBtwEventSource(parentTopic, { EventSourceImpl });
  source.addEventListener("btw-changed", (event) => {
    const payload = decodeBtwChanged(event.data);
    if (Option.isSome(payload)) onChanged(payload.value.sessionId ?? "");
  });
  source.onerror = () => undefined;
  return source;
}

export function closeBtwEventSource(source: Pick<EventSource, "close"> | null | undefined): void {
  if (!source) return;
  runSync(
    Effect.try({
      try: () => source.close(),
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined))),
  );
}
