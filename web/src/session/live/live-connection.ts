import {
  createSessionEventSource,
  wireSessionEvents,
  type EventSourceConstructor,
  type EventSourceLike,
  type SessionEvent,
} from "./live-events.js";
import { Effect } from "effect";
import { runSync } from "../../lib/runtime.js";

const EVENT_SOURCE_CLOSED = 2;

interface LiveWindow {
  readonly EventSource?: EventSourceConstructor;
  readonly CustomEvent?: typeof CustomEvent;
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(timer: number): void;
  addEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListener,
    options?: boolean | EventListenerOptions,
  ): void;
  dispatchEvent(event: Event): boolean;
}

const getDefaultLiveWindow = (): LiveWindow => ({
  EventSource: undefined,
  CustomEvent,
  setTimeout: (handler, timeout) => window.setTimeout(handler, timeout),
  clearTimeout: (timer) => window.clearTimeout(timer),
  addEventListener: (type, listener, options) => window.addEventListener(type, listener, options),
  removeEventListener: (type, listener, options) =>
    window.removeEventListener(type, listener, options),
  dispatchEvent: (event) => window.dispatchEvent(event),
});

export function reconnectDelay(
  attempt: number,
  { randomImpl = Math.random }: { readonly randomImpl?: () => number } = {},
): number {
  const base = Math.min(30000, 1000 * Math.pow(2, attempt));
  return base + Math.floor(randomImpl() * 500);
}

export function setupSessionLiveConnection({
  documentImpl = document,
  windowImpl = getDefaultLiveWindow(),
  sessionId,
  createEventSource = createSessionEventSource,
  wireEvents = wireSessionEvents,
  onReload = () => {},
  onChatPreview = () => {},
  onError = () => {},
  setTimeoutImpl = windowImpl.setTimeout.bind(windowImpl),
  clearTimeoutImpl = windowImpl.clearTimeout.bind(windowImpl),
  randomImpl = Math.random,
}: {
  readonly documentImpl?: Document;
  readonly windowImpl?: LiveWindow;
  readonly sessionId: string;
  readonly createEventSource?: typeof createSessionEventSource;
  readonly wireEvents?: (options: Parameters<typeof wireSessionEvents>[0]) => unknown;
  readonly onReload?: (event?: SessionEvent) => unknown;
  readonly onChatPreview?: (payload: unknown) => void;
  readonly onError?: (error?: unknown) => void;
  readonly setTimeoutImpl?: (handler: () => void, timeout: number) => number;
  readonly clearTimeoutImpl?: (timer: number) => void;
  readonly randomImpl?: () => number;
}): {
  connect: () => EventSourceLike;
  scheduleReconnect: () => void;
  currentEventSource: () => EventSourceLike | null;
  dispose: () => void;
} {
  let eventSource: EventSourceLike | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  function closeEventSource(): void {
    if (!eventSource) return;
    runSync(
      Effect.try({ try: () => eventSource?.close?.(), catch: (cause) => cause }).pipe(
        Effect.catch(() => Effect.void),
      ),
    );
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  function connect(): EventSourceLike {
    clearReconnectTimer();
    closeEventSource();
    eventSource = createEventSource(sessionId, {
      EventSourceImpl: windowImpl.EventSource,
    });
    wireEvents({
      eventSource,
      onReload,
      onChatPreview,
      onError: (error) => {
        onError(error);
        if (!eventSource || eventSource.readyState !== EVENT_SOURCE_CLOSED) return;
        scheduleReconnect();
      },
      windowImpl,
      CustomEventImpl: windowImpl.CustomEvent,
    });
    reconnectAttempt = 0;
    return eventSource;
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    const delay = reconnectDelay(reconnectAttempt, { randomImpl });
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
      onReload();
    }, delay);
  }

  function reconnectAndReload(): void {
    reconnectAttempt = 0;
    connect();
    onReload();
  }

  const onVisibilityChange = () => {
    if (documentImpl.hidden) return;
    if (!eventSource || eventSource.readyState === EVENT_SOURCE_CLOSED) {
      reconnectAndReload();
    } else {
      onReload();
    }
  };
  const onOnline = () => {
    reconnectAndReload();
  };

  documentImpl.addEventListener("visibilitychange", onVisibilityChange);
  windowImpl.addEventListener("online", onOnline);

  return {
    connect,
    scheduleReconnect,
    currentEventSource: () => eventSource,
    dispose: () => {
      clearReconnectTimer();
      closeEventSource();
      documentImpl.removeEventListener("visibilitychange", onVisibilityChange);
      windowImpl.removeEventListener("online", onOnline);
    },
  };
}
