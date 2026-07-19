import { Effect, Option } from "effect";
import { runSync } from "../lib/runtime";
import { parseStatusEvent } from "../lib/sse";

interface LegacyEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null;
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
  readonly onReconnect?: () => void;
}

const parse = (type: string, data: string) => runSync(Effect.option(parseStatusEvent(type, data)));

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
  onReconnect = () => undefined,
}: StatusEventsOptions = {}) {
  let stream: LegacyEventSource | null = null;
  let pagehideHandler: EventListener | null = null;
  let pageshowHandler: EventListener | null = null;
  let everConnected = false;

  const closeStream = () => {
    stream?.close();
    stream = null;
  };

  const cleanup = () => {
    closeStream();
    if (pagehideHandler !== null && windowImpl.removeEventListener) {
      windowImpl.removeEventListener("pagehide", pagehideHandler);
      pagehideHandler = null;
    }
    if (pageshowHandler !== null && windowImpl.removeEventListener) {
      windowImpl.removeEventListener("pageshow", pageshowHandler);
      pageshowHandler = null;
    }
  };

  const connect = () => {
    if (EventSourceImpl === undefined) return;
    cleanup();
    const eventSource = new EventSourceImpl(`/events?id=${encodeURIComponent(topic)}`);
    stream = eventSource;

    eventSource.addEventListener("open", () => {
      if (everConnected) onReconnect();
      everConnected = true;
    });
    eventSource.onmessage = (event) => {
      onMessage(event.data);
      const parsed = Option.getOrUndefined(parse("message", event.data));
      if (parsed?.type === "reload") onReload({ id: parsed.id });
    };
    eventSource.addEventListener("status-snapshot", (event) => {
      const parsed = Option.getOrUndefined(
        parse("status-snapshot", (event as MessageEvent<string>).data),
      );
      if (parsed?.type !== "status-snapshot") return;
      onSnapshot({ ids: parsed.data.running, statuses: parsed.data.statuses });
    });
    eventSource.addEventListener("status-delta", (event) => {
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
      const parsed = Option.getOrUndefined(
        parse("workflows-updated", (event as MessageEvent<string>).data),
      );
      if (parsed?.type === "workflows-updated") onWorkflowUpdate(parsed.data);
    });
    eventSource.addEventListener("tasks-updated", (event) => {
      const parsed = Option.getOrUndefined(
        parse("tasks-updated", (event as MessageEvent<string>).data),
      );
      if (parsed?.type === "tasks-updated") onTasksUpdate(parsed.data);
    });

    if (windowImpl.addEventListener) {
      pagehideHandler = () => closeStream();
      pageshowHandler = () => {
        if (stream === null) connect();
      };
      windowImpl.addEventListener("pagehide", pagehideHandler);
      windowImpl.addEventListener("pageshow", pageshowHandler);
    }
  };

  return { connect, cleanup };
}
