import { Effect, Schema } from "effect";
import { runPromise, runSync } from "../../lib/runtime.js";
import {
  isUnknownRecord,
  sessionEntryFromUnknown,
  type SessionEntry,
  type UnknownRecord,
  type WorkerProcessStatus,
} from "../data/session-types.js";

export interface SessionEvent {
  readonly data: string;
}

export interface EventSourceLike {
  onmessage?: ((event: SessionEvent) => void) | null;
  onerror?: ((event: Event) => void) | null;
  readonly readyState?: number;
  addEventListener(type: string, listener: (event: SessionEvent) => void): void;
  close?(): void;
}

export interface EventSourceConstructor {
  new (url: string): EventSourceLike;
}

class BrowserEventSource implements EventSourceLike {
  readonly #source: EventSource;
  onmessage: ((event: SessionEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.#source = new EventSource(url);
    this.#source.onmessage = (event) => this.onmessage?.({ data: event.data });
    this.#source.onerror = (event) => this.onerror?.(event);
  }

  get readyState(): number {
    return this.#source.readyState;
  }

  addEventListener(type: string, listener: (event: SessionEvent) => void): void {
    this.#source.addEventListener(type, (event) => {
      if (event instanceof MessageEvent) listener({ data: String(event.data) });
    });
  }

  close(): void {
    this.#source.close();
  }
}

interface ReloadModel {
  readonly truncated?: boolean;
  readonly header?: UnknownRecord | null;
  readonly entries: ReadonlyArray<SessionEntry>;
}

interface EntryState {
  readonly seen: Set<unknown>;
  readonly liveRendered: Set<unknown>;
}

type FetchImpl = (url: string) => Promise<unknown>;
type MaybePromise = unknown;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  isUnknownRecord(value) && typeof value.then === "function";

const JsonRecordSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeEventRecord = Schema.decodeUnknownEffect(JsonRecordSchema);

export function getSessionIdFromLocation({
  locationImpl = location,
}: { readonly locationImpl?: Pick<Location, "search"> } = {}): string {
  return locationImpl.search.split("id=")[1]?.split("&")[0] || "";
}

export function createSessionEventSource(
  sessionId: string,
  {
    EventSourceImpl = BrowserEventSource,
  }: { readonly EventSourceImpl?: EventSourceConstructor } = {},
): EventSourceLike {
  return new EventSourceImpl("/events?id=" + encodeURIComponent(sessionId));
}

export function getReloadEntryCount(model: ReloadModel | null | undefined): number | null {
  if (!model || model.truncated || model.header?.runtime === "codex") return null;
  return model.entries.length;
}

export async function handleSessionReload({
  sessionId,
  fetchImpl = fetch,
  entryState,
  clearChatPreview = () => {},
  appendEntry,
  upsertEntry,
  refreshEntriesAffectedByToolResult,
  updateStats = () => {},
  updateTitle = () => {},
  isFollowing = () => false,
  isAtBottom = () => false,
  scrollAfterLayout = () => {},
  incrementPending = () => {},
  showFollowButton = () => {},
  onReloaded = () => {},
  onNewEntries = null,
  getEntryCount = null,
  shouldApply = () => true,
}: {
  readonly sessionId: string;
  readonly fetchImpl?: FetchImpl;
  readonly entryState: EntryState;
  readonly clearChatPreview?: () => void;
  readonly appendEntry?: (entry: SessionEntry, entries: SessionEntry[]) => boolean;
  readonly upsertEntry?: (entry: SessionEntry, entries: SessionEntry[]) => void;
  readonly refreshEntriesAffectedByToolResult?: (
    entry: SessionEntry,
    entries: SessionEntry[],
  ) => void;
  readonly updateStats?: (entries: SessionEntry[]) => void;
  readonly updateTitle?: (title: string) => void;
  readonly isFollowing?: () => boolean;
  readonly isAtBottom?: () => boolean;
  readonly scrollAfterLayout?: (smooth: boolean) => void;
  readonly incrementPending?: (count: number) => void;
  readonly showFollowButton?: () => void;
  readonly onReloaded?: (
    data: UnknownRecord & { entries: SessionEntry[]; isDelta: boolean },
  ) => MaybePromise;
  readonly onNewEntries?: ((ids: string[]) => void) | null;
  readonly getEntryCount?: (() => number | null | undefined) | null;
  readonly shouldApply?: () => boolean;
}): Promise<{ entries: SessionEntry[]; newCount: number; stale?: true }> {
  // getEntryCount is a live getter into the canonical entry count (typically
  // model.entries.length), not a value snapshotted once — reading it fresh
  // here keeps this correct even if something else (e.g. LoadEarlier
  // prepending older entries) changed the model between reloads. It should
  // return null/undefined when a from-0 count isn't meaningful (e.g. a
  // tail-windowed/paginated large session), which disables the delta request.
  const afterCount = typeof getEntryCount === "function" ? getEntryCount() : null;
  const hasValidAfterCount = typeof afterCount === "number" && afterCount >= 0;
  let url = "/api/session?id=" + encodeURIComponent(sessionId);
  if (hasValidAfterCount) {
    url += "&afterCount=" + afterCount;
  }
  const dataValue = await runPromise(
    Effect.tryPromise({
      try: async () => {
        const response = await fetchImpl(url);
        if (response instanceof Response) return response.json();
        if (isUnknownRecord(response) && typeof response.json === "function")
          return response.json();
        return {};
      },
      catch: (cause) => cause,
    }),
  );
  const data = isUnknownRecord(dataValue) ? dataValue : {};
  if (!shouldApply()) {
    return { entries: [], newCount: 0, stale: true };
  }
  const entries = Array.isArray(data.entries)
    ? data.entries.flatMap((entry) => {
        const normalized = sessionEntryFromUnknown(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const isDelta = hasValidAfterCount && data.deltaOk === true;
  // Reactive callers may return a render barrier (for example Svelte's tick).
  // Wait for canonical entries to reach the DOM before removing the imperative
  // preview, so the handoff has neither a blank frame nor duplicate text.
  await onReloaded({ ...data, entries, isDelta });
  if (typeof data.name === "string" && data.name.trim()) {
    updateTitle(data.name);
  }
  let newCount = 0;

  // Two modes:
  //  • Imperative (appendEntry provided): patch #messages DOM directly. Kept
  //    for isolated helper tests and non-Svelte callers.
  //  • Reactive (no appendEntry): the Svelte <SessionContent> owns #messages and
  //    re-renders from the model that onReloaded just updated, so here we only
  //    track which ids are brand-new (for follow/scroll/highlight decisions).
  const reactive = typeof appendEntry !== "function";
  const newIds: string[] = [];

  entries.forEach((entry) => {
    if (!entry.id) return;
    if (reactive) {
      if (!entryState.seen.has(entry.id)) {
        entryState.seen.add(entry.id);
        newCount++;
        newIds.push(entry.id);
      }
      return;
    }
    if (!entryState.seen.has(entry.id)) {
      if (appendEntry(entry, entries)) newCount++;
      if (entry.message && entry.message.role === "toolResult") {
        refreshEntriesAffectedByToolResult?.(entry, entries);
      }
    } else if (entryState.liveRendered.has(entry.id)) {
      upsertEntry?.(entry, entries);
      if (entry.message && entry.message.role === "toolResult") {
        refreshEntriesAffectedByToolResult?.(entry, entries);
      }
    } else if (entry.message && entry.message.role === "toolResult") {
      refreshEntriesAffectedByToolResult?.(entry, entries);
    }
  });

  // Clear optimistic pending user/assistant preview only after canonical
  // entries have been appended/upserted (imperative) or merged into the model
  // (reactive). Clearing earlier creates a visible blank/flicker when a cold
  // worker finally writes the real message.
  clearChatPreview();

  if (newCount > 0) {
    updateStats(entries);
    // Decide on the live scroll position, not just the cached follow flag: the
    // viewport can be pinned to the bottom while `following` is momentarily
    // stale, in which case showing the button would be wrong.
    if (isFollowing() || isAtBottom()) {
      scrollAfterLayout(true);
    } else {
      incrementPending(newCount);
      showFollowButton();
    }
  }

  // Reactive mode: once Svelte has rendered the new entries, flag them so the
  // caller can apply the new-entry highlight.
  if (newIds.length && typeof onNewEntries === "function") {
    onNewEntries(newIds);
  }

  return { entries, newCount };
}

export function wireSessionEvents({
  eventSource,
  onReload,
  onChatPreview,
  onWorkerStatus = () => {},
  onError = () => {},
  windowImpl = typeof window !== "undefined" ? window : null,
  CustomEventImpl = typeof CustomEvent !== "undefined" ? CustomEvent : null,
}: {
  readonly eventSource: EventSourceLike;
  readonly onReload: (event?: SessionEvent) => MaybePromise;
  readonly onChatPreview: (payload: UnknownRecord) => void;
  readonly onWorkerStatus?: (status: WorkerProcessStatus) => void;
  readonly onError?: (error?: unknown) => void;
  readonly windowImpl?: { dispatchEvent(event: unknown): boolean } | null;
  readonly CustomEventImpl?:
    | (new (type: string, init?: { readonly detail?: unknown }) => unknown)
    | null;
}): EventSourceLike {
  const dispatch = (type: string, detail?: unknown): void => {
    if (!windowImpl || !CustomEventImpl) return;
    runSync(
      Effect.try({
        try: () => windowImpl.dispatchEvent(new CustomEventImpl(type, { detail })),
        catch: () => false,
      }),
    );
  };
  const dispatchReloadedEvent = () => {
    dispatch("pi-session-reload");
  };
  const withEventRecord = (
    event: SessionEvent,
    consume: (payload: UnknownRecord) => void,
  ): void => {
    runSync(
      decodeEventRecord(event.data).pipe(
        Effect.match({
          onFailure: (error) => onError(error),
          onSuccess: consume,
        }),
      ),
    );
  };

  eventSource.onmessage = (event) => {
    if (event.data !== "reload") return;
    // `onReload` returns a Promise once handleSessionReload starts; await it so
    // the broadcast fires *after* the model has the new entries. Otherwise
    // listeners that read the model on this event (e.g. steer-queue reconciling
    // its chips against newly-arrived user messages) race the fetch and see a
    // stale snapshot.
    const result = onReload(event);
    if (isPromiseLike(result)) {
      result.then(dispatchReloadedEvent, dispatchReloadedEvent);
    } else {
      dispatchReloadedEvent();
    }
  };
  eventSource.addEventListener("chat-preview", (event) => {
    withEventRecord(event, (payload) => {
      onChatPreview(payload);
      // The file-watch 'reload' event is dropped for a brand-new session's first
      // write (the watcher treats it as an initial observation, not a change), so
      // the canonical entries would never reconcile until a manual refresh. The
      // chat-preview stream is worker-driven and independent of the watcher, so
      // its 'done' signal is a reliable trigger to pull the written entries.
      if (payload.done) {
        const result = onReload(event);
        if (isPromiseLike(result)) {
          result.then(dispatchReloadedEvent, dispatchReloadedEvent);
        } else {
          dispatchReloadedEvent();
        }
      }
    });
  });
  eventSource.addEventListener("worker-status", (event) => {
    withEventRecord(event, (payload) => {
      if (typeof payload.state !== "string") return;
      onWorkerStatus?.({
        state: payload.state,
        error: typeof payload.error === "string" ? payload.error : undefined,
        exitCode: typeof payload.exitCode === "number" ? payload.exitCode : undefined,
      });
    });
  });
  // 'queue' is fired by the backend whenever the per-session chat_queue
  // changes — autonomous drainer, another tab, etc. ChatComposer listens for
  // pi-queue-event on the window and refetches /api/chat/queue.
  eventSource.addEventListener("queue", () => {
    dispatch("pi-queue-event");
  });
  const extensionEvents: ReadonlyArray<readonly [string, string]> = [
    ["extension-ui-request", "pi-extension-ui-request"],
    ["extension-ui-resolved", "pi-extension-ui-resolved"],
    ["extension-notify", "pi-extension-notify"],
  ];
  for (const [eventName, windowEvent] of extensionEvents) {
    eventSource.addEventListener(eventName, (event) => {
      withEventRecord(event, (payload) => dispatch(windowEvent, payload));
    });
  }
  eventSource.onerror = (event) => onError(event);
  return eventSource;
}
