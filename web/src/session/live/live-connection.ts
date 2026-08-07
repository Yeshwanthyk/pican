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
export const DEFAULT_HEARTBEAT_STALE_MS = 45_000;

export type SessionConnectionState = "connecting" | "current" | "reconnecting" | "stale";

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

type ReloadResult = boolean | void;
type ReloadHandler = (
  event?: SessionEvent,
  shouldApply?: () => boolean,
) => ReloadResult | PromiseLike<ReloadResult>;

export function setupSessionLiveConnection({
  documentImpl = document,
  windowImpl = getDefaultLiveWindow(),
  sessionId,
  createEventSource = createSessionEventSource,
  wireEvents = wireSessionEvents,
  onReload = () => true,
  onChatPreview = () => {},
  onWorkerStatus = () => {},
  onError = () => {},
  onStateChange = () => {},
  now = Date.now,
  heartbeatStaleMs = DEFAULT_HEARTBEAT_STALE_MS,
  setTimeoutImpl = windowImpl.setTimeout.bind(windowImpl),
  clearTimeoutImpl = windowImpl.clearTimeout.bind(windowImpl),
  randomImpl = Math.random,
}: {
  readonly documentImpl?: Document;
  readonly windowImpl?: LiveWindow;
  readonly sessionId: string;
  readonly createEventSource?: typeof createSessionEventSource;
  readonly wireEvents?: (options: Parameters<typeof wireSessionEvents>[0]) => unknown;
  readonly onReload?: ReloadHandler;
  readonly onChatPreview?: (payload: unknown) => void;
  readonly onWorkerStatus?: (
    status: import("../data/session-types.js").WorkerProcessStatus,
  ) => void;
  readonly onError?: (error?: unknown) => void;
  readonly onStateChange?: (state: SessionConnectionState) => void;
  readonly now?: () => number;
  readonly heartbeatStaleMs?: number;
  readonly setTimeoutImpl?: (handler: () => void, timeout: number) => number;
  readonly clearTimeoutImpl?: (timer: number) => void;
  readonly randomImpl?: () => number;
}): {
  connect: () => EventSourceLike;
  recover: () => Promise<boolean>;
  scheduleReconnect: () => void;
  currentEventSource: () => EventSourceLike | null;
  currentState: () => SessionConnectionState;
  dispose: () => void;
} {
  let eventSource: EventSourceLike | null = null;
  let generation = 0;
  let disposed = false;
  let sourceOpen = false;
  let everOpened = false;
  let state: SessionConnectionState = "connecting";
  let lastHeartbeatAt: number | null = null;
  let reconnectTimer: number | null = null;
  let staleTimer: number | null = null;
  let reconnectAttempt = 0;
  let pendingRecovery: { readonly generation: number; readonly promise: Promise<boolean> } | null =
    null;

  const isCurrent = (targetGeneration: number, source: EventSourceLike | null): boolean =>
    !disposed && generation === targetGeneration && eventSource === source;

  function setState(next: SessionConnectionState): void {
    if (state === next) return;
    state = next;
    onStateChange(next);
  }

  function closeSource(source: EventSourceLike | null): void {
    if (!source) return;
    runSync(
      Effect.try({ try: () => source.close?.(), catch: (cause) => cause }).pipe(
        Effect.catch(() => Effect.void),
      ),
    );
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === null) return;
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  function clearStaleTimer(): void {
    if (staleTimer === null) return;
    clearTimeoutImpl(staleTimer);
    staleTimer = null;
  }

  function scheduleFreshnessCheck(targetGeneration: number, source: EventSourceLike): void {
    clearStaleTimer();
    if (lastHeartbeatAt === null || !isCurrent(targetGeneration, source)) return;
    const delay = Math.max(0, heartbeatStaleMs - (now() - lastHeartbeatAt));
    staleTimer = setTimeoutImpl(() => {
      staleTimer = null;
      if (!isCurrent(targetGeneration, source)) return;
      if (documentImpl.hidden) return;
      if (lastHeartbeatAt !== null && now() - lastHeartbeatAt < heartbeatStaleMs) {
        scheduleFreshnessCheck(targetGeneration, source);
        return;
      }
      setState("stale");
      replaceStream("stale");
    }, delay);
  }

  function recoverGeneration(
    targetGeneration: number,
    source: EventSourceLike,
    event?: SessionEvent,
  ): Promise<boolean> {
    if (!isCurrent(targetGeneration, source)) return Promise.resolve(false);
    if (pendingRecovery?.generation === targetGeneration) return pendingRecovery.promise;

    if (state !== "connecting" && state !== "stale") setState("reconnecting");
    const shouldApply = () => isCurrent(targetGeneration, source);
    const promise = Promise.resolve()
      .then(() => onReload(event, shouldApply))
      .then(
        (result) => result !== false,
        (error) => {
          if (shouldApply()) onError(error);
          return false;
        },
      )
      .then((recovered) => {
        if (!shouldApply()) return false;
        if (recovered && sourceOpen) {
          setState("current");
        } else if (!recovered) {
          setState(documentImpl.hidden ? "reconnecting" : "stale");
        }
        return recovered;
      })
      .finally(() => {
        if (pendingRecovery?.generation === targetGeneration) pendingRecovery = null;
      });
    pendingRecovery = { generation: targetGeneration, promise };
    return promise;
  }

  function scheduleReconnectFor(targetGeneration: number, source: EventSourceLike): void {
    if (!isCurrent(targetGeneration, source) || reconnectTimer !== null) return;
    const delay = reconnectDelay(reconnectAttempt, { randomImpl });
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      if (!isCurrent(targetGeneration, source)) return;
      replaceStream("reconnecting");
    }, delay);
  }

  function replaceStream(nextState: "connecting" | "reconnecting" | "stale"): EventSourceLike {
    const previous = eventSource;
    generation += 1;
    const targetGeneration = generation;
    clearReconnectTimer();
    clearStaleTimer();
    pendingRecovery = null;
    sourceOpen = false;
    lastHeartbeatAt = null;
    closeSource(previous);

    if (nextState === "stale") setState("stale");
    else setState(everOpened ? "reconnecting" : nextState);

    const source = createEventSource(sessionId, {
      EventSourceImpl: windowImpl.EventSource,
    });
    eventSource = source;
    const recoverOnFirstOpen = nextState !== "connecting" || everOpened;
    let sourceHasOpened = false;
    const shouldHandle = () => isCurrent(targetGeneration, source);

    wireEvents({
      eventSource: source,
      shouldHandle,
      onOpen: () => {
        if (!shouldHandle()) return;
        const shouldRecover = recoverOnFirstOpen || sourceHasOpened;
        sourceHasOpened = true;
        sourceOpen = true;
        everOpened = true;
        lastHeartbeatAt = now();
        reconnectAttempt = 0;
        clearReconnectTimer();
        scheduleFreshnessCheck(targetGeneration, source);
        // SessionPage has just completed an authoritative read before the first
        // stream opens. Refetch only when an open follows a possible event gap.
        if (shouldRecover) void recoverGeneration(targetGeneration, source);
        else setState("current");
      },
      onHeartbeat: () => {
        if (!shouldHandle()) return;
        lastHeartbeatAt = now();
        scheduleFreshnessCheck(targetGeneration, source);
        if (state !== "current" && sourceOpen) {
          void recoverGeneration(targetGeneration, source);
        }
      },
      onReload: (event) => recoverGeneration(targetGeneration, source, event),
      onChatPreview: (payload) => {
        if (shouldHandle()) onChatPreview(payload);
      },
      onWorkerStatus: (status) => {
        if (shouldHandle()) onWorkerStatus(status);
      },
      onError: (error) => {
        if (shouldHandle()) onError(error);
      },
      onTransportError: (error) => {
        if (!shouldHandle()) return;
        sourceOpen = false;
        clearStaleTimer();
        onError(error);
        setState("reconnecting");
        if (source.readyState === EVENT_SOURCE_CLOSED) {
          scheduleReconnectFor(targetGeneration, source);
        }
      },
      windowImpl,
      CustomEventImpl: windowImpl.CustomEvent,
    });
    return source;
  }

  function retireStream(): void {
    const previous = eventSource;
    generation += 1;
    clearReconnectTimer();
    clearStaleTimer();
    pendingRecovery = null;
    eventSource = null;
    sourceOpen = false;
    lastHeartbeatAt = null;
    closeSource(previous);
  }

  function resumeFromLifecycle(): void {
    if (disposed || documentImpl.hidden) return;
    const source = eventSource;
    if (source && lastHeartbeatAt !== null && now() - lastHeartbeatAt >= heartbeatStaleMs) {
      setState("stale");
      replaceStream("stale");
      return;
    }
    if (!source || source.readyState === EVENT_SOURCE_CLOSED) {
      replaceStream("reconnecting");
      return;
    }
    scheduleFreshnessCheck(generation, source);
    void recoverGeneration(generation, source);
  }

  const onVisibilityChange = () => resumeFromLifecycle();
  const onOnline = () => {
    if (disposed) return;
    replaceStream("reconnecting");
  };
  const onPageHide = () => {
    if (!disposed) retireStream();
  };
  const onPageShow = () => resumeFromLifecycle();

  documentImpl.addEventListener("visibilitychange", onVisibilityChange);
  windowImpl.addEventListener("online", onOnline);
  windowImpl.addEventListener("pagehide", onPageHide);
  windowImpl.addEventListener("pageshow", onPageShow);

  return {
    connect: () => replaceStream(everOpened ? "reconnecting" : "connecting"),
    recover: () => {
      const source = eventSource;
      return source ? recoverGeneration(generation, source) : Promise.resolve(false);
    },
    scheduleReconnect: () => {
      const source = eventSource;
      if (source) scheduleReconnectFor(generation, source);
    },
    currentEventSource: () => eventSource,
    currentState: () => state,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      retireStream();
      documentImpl.removeEventListener("visibilitychange", onVisibilityChange);
      windowImpl.removeEventListener("online", onOnline);
      windowImpl.removeEventListener("pagehide", onPageHide);
      windowImpl.removeEventListener("pageshow", onPageShow);
    },
  };
}
