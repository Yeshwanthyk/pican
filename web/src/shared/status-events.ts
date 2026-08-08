import { Effect, Option, Schema } from "effect";
import { DecodeError } from "../lib/errors";
import { runSync } from "../lib/runtime";
import { parseStatusEvent } from "../lib/sse";
import { withBasePath } from "./base-path";

interface LegacyEventSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(name: string, listener: EventListener): void;
  close(): void;
}

interface EventSourceConstructor {
  new (url: string): LegacyEventSource;
}

interface WindowEvents {
  addEventListener?(name: string, listener: EventListener): void;
  removeEventListener?(name: string, listener: EventListener): void;
}

interface Snapshot {
  readonly ids: ReadonlyArray<string>;
  readonly statuses: Readonly<Record<string, unknown>>;
}

interface Delta {
  readonly id: string;
  readonly running: boolean;
  readonly model: string;
  readonly modelName: string;
  readonly modelProvider: string;
}

const StatusHeartbeatSchema = Schema.Struct({
  timestamp: Schema.String,
  freshness: Schema.Literal("transport-only"),
});
export type StatusHeartbeat = typeof StatusHeartbeatSchema.Type;

export interface StatusEventsOptions {
  readonly topic?: string;
  readonly EventSourceImpl?: EventSourceConstructor;
  readonly windowImpl?: WindowEvents;
  readonly onSnapshot?: (snapshot: Snapshot) => void;
  readonly onDelta?: (delta: Delta) => void;
  readonly onMessage?: (message: string) => void;
  readonly onReload?: (reload: { readonly id: string }) => void;
  readonly onWorkflowUpdate?: (payload: { readonly runId: string }) => void;
  readonly onTasksUpdate?: (payload: { readonly project: string }) => void;
  readonly onCurationUpdate?: () => void;
  readonly onOpen?: () => void;
  readonly onError?: (error?: unknown) => void;
  readonly onHeartbeat?: (heartbeat: StatusHeartbeat) => void;
  readonly onReconnect?: () => void;
}

const parse = (type: string, data: string) => runSync(Effect.option(parseStatusEvent(type, data)));

const decodeStatusHeartbeat = Schema.decodeUnknownOption(
  Schema.fromJsonString(StatusHeartbeatSchema),
);

const parseHeartbeat = (data: string): StatusHeartbeat | null => {
  const value = Option.getOrNull(decodeStatusHeartbeat(data));
  return value && Number.isFinite(Date.parse(value.timestamp)) ? value : null;
};

export function createStatusEvents({
  topic = "__all__",
  EventSourceImpl = globalThis.EventSource,
  windowImpl = globalThis.window,
  onSnapshot = () => undefined,
  onDelta = () => undefined,
  onMessage = () => undefined,
  onReload = () => undefined,
  onWorkflowUpdate = () => undefined,
  onTasksUpdate = () => undefined,
  onCurationUpdate = () => undefined,
  onOpen = () => undefined,
  onError = () => undefined,
  onHeartbeat = () => undefined,
  onReconnect = () => undefined,
}: StatusEventsOptions = {}) {
  let stream: LegacyEventSource | null = null;
  let generation = 0;
  let listening = false;
  let disposed = false;
  let everOpened = false;

  const isCurrent = (targetGeneration: number, source: LegacyEventSource): boolean =>
    !disposed && generation === targetGeneration && stream === source;

  const retireStream = () => {
    generation += 1;
    const previous = stream;
    stream = null;
    previous?.close();
  };

  const pagehideHandler: EventListener = () => retireStream();
  const pageshowHandler: EventListener = () => {
    if (stream === null) replaceStream();
  };

  const removeLifecycleListeners = () => {
    if (!listening || !windowImpl.removeEventListener) return;
    windowImpl.removeEventListener("pagehide", pagehideHandler);
    windowImpl.removeEventListener("pageshow", pageshowHandler);
    listening = false;
  };

  const addLifecycleListeners = () => {
    if (listening || !windowImpl.addEventListener) return;
    windowImpl.addEventListener("pagehide", pagehideHandler);
    windowImpl.addEventListener("pageshow", pageshowHandler);
    listening = true;
  };

  function replaceStream(): void {
    if (disposed || EventSourceImpl === undefined) return;
    retireStream();
    const targetGeneration = generation;
    const eventSource = new EventSourceImpl(
      withBasePath(`/events?id=${encodeURIComponent(topic)}`),
    );
    stream = eventSource;
    const shouldHandle = () => isCurrent(targetGeneration, eventSource);

    eventSource.onopen = () => {
      if (!shouldHandle()) return;
      onOpen();
      if (everOpened) onReconnect();
      everOpened = true;
    };
    eventSource.onerror = (event) => {
      if (shouldHandle()) onError(event);
    };
    eventSource.onmessage = (event) => {
      if (!shouldHandle()) return;
      onMessage(event.data);
      const parsed = Option.getOrUndefined(parse("message", event.data));
      if (parsed?.type === "reload") onReload({ id: parsed.id });
    };
    eventSource.addEventListener("heartbeat", (event) => {
      if (!shouldHandle()) return;
      const heartbeat = parseHeartbeat((event as MessageEvent<string>).data);
      if (heartbeat) onHeartbeat(heartbeat);
      else
        onError(
          new DecodeError({ url: "/events", issue: "invalid heartbeat payload" }),
        );
    });
    eventSource.addEventListener("status-snapshot", (event) => {
      if (!shouldHandle()) return;
      const parsed = Option.getOrUndefined(
        parse("status-snapshot", (event as MessageEvent<string>).data),
      );
      if (parsed?.type !== "status-snapshot") return;
      onSnapshot({ ids: parsed.data.running, statuses: parsed.data.statuses });
    });
    eventSource.addEventListener("status-delta", (event) => {
      if (!shouldHandle()) return;
      const parsed = Option.getOrUndefined(
        parse("status-delta", (event as MessageEvent<string>).data),
      );
      if (parsed?.type !== "status-delta") return;
      onDelta({
        id: parsed.data.id,
        running: parsed.data.running,
        model: parsed.data.model ?? "",
        modelName: parsed.data.modelName ?? "",
        modelProvider: parsed.data.modelProvider ?? "",
      });
    });
    eventSource.addEventListener("workflows-updated", (event) => {
      if (!shouldHandle()) return;
      const parsed = Option.getOrUndefined(
        parse("workflows-updated", (event as MessageEvent<string>).data),
      );
      if (parsed?.type === "workflows-updated") onWorkflowUpdate(parsed.data);
    });
    eventSource.addEventListener("tasks-updated", (event) => {
      if (!shouldHandle()) return;
      const parsed = Option.getOrUndefined(
        parse("tasks-updated", (event as MessageEvent<string>).data),
      );
      if (parsed?.type === "tasks-updated") onTasksUpdate(parsed.data);
    });
    eventSource.addEventListener("curation-updated", (event) => {
      if (!shouldHandle()) return;
      const parsed = Option.getOrUndefined(
        parse("curation-updated", (event as MessageEvent<string>).data),
      );
      if (parsed?.type === "curation-updated") onCurationUpdate();
    });
  }

  const connect = () => {
    if (disposed) return;
    addLifecycleListeners();
    replaceStream();
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    retireStream();
    removeLifecycleListeners();
  };

  return { connect, cleanup };
}
