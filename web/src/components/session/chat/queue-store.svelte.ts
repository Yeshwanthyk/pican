// Reactive state behind the docked queue panel above the composer.
//
// Two kinds of items share one ordered list:
//
//   - queued — pending messages owned by the *server* (chat_queue table). The
//     autonomous drainer runs them when the worker becomes idle, even when no
//     browser is connected. We hydrate from GET /api/chat/queue on mount and
//     re-fetch when an SSE 'queue' event lands so other tabs stay in sync.
//   - steer  — in-flight prompts the worker is folding into the active run.
//     These belong to a specific stream that has no meaning after the page
//     goes away, so they live only in browser memory.
//
// All queued-side mutations go through the QueueApi (queue-api.js); the
// runtime glue (steer-queue.js) wraps these for the user-facing actions
// (enqueue, sendNow, edit, resume, remove).

import type { QueueItem, QueueState } from "../../../lib/schema";
import type { QueueApi } from "./queue-api";

export type QueueDisplayItem =
  | {
      readonly id: string;
      readonly kind: "queued";
      readonly position: number;
      readonly text: string;
      readonly displayText: string;
      readonly files?: readonly File[];
    }
  | {
      readonly id: string;
      readonly kind: "steer";
      readonly text: string;
      readonly displayText: string;
    };

export class QueueStore {
  items = $state<QueueDisplayItem[]>([]);
  paused = $state(false);
  focusIndex = $state(-1);

  actions: {
    sendNow: (id: string) => void;
    edit: (id: string) => void;
    resume: () => void;
  } = {
    sendNow: () => undefined,
    edit: () => undefined,
    resume: () => undefined,
  };

  #api: QueueApi | null;
  #steerSeq = 0;
  #pendingRefresh: Promise<void> | null = null;

  constructor({ api = null }: { readonly api?: QueueApi | null } = {}) {
    this.#api = api;
  }

  get isEmpty() {
    return this.items.length === 0;
  }

  get count() {
    return this.items.length;
  }

  get queuedCount() {
    return this.items.filter((item) => item.kind === "queued").length;
  }

  get steerCount() {
    return this.items.filter((item) => item.kind === "steer").length;
  }

  get persistsLocally() {
    // The panel header uses this to render the "saved on server" hint when
    // there's a real API backing the store.
    return !!this.#api;
  }

  // ── Server-backed loading ─────────────────────────────────────────────────

  /** Pull the latest snapshot from the server, replacing the queued portion
   *  of `items` and the paused flag. Steers (browser-only) are preserved.
   *  Concurrent callers share the in-flight Promise so they all see the same
   *  resolved state without firing duplicate GETs. */
  refresh = () => {
    if (!this.#api) return Promise.resolve();
    if (this.#pendingRefresh) return this.#pendingRefresh;
    this.#pendingRefresh = this.#api
      .list()
      .then(
        (snapshot) => {
          this.#mergeServerSnapshot(snapshot);
        },
        () => undefined,
      )
      .then(() => {
        this.#pendingRefresh = null;
      });
    return this.#pendingRefresh;
  };

  #mergeServerSnapshot(snapshot: QueueState) {
    const serverItems = snapshot.items;
    const steers = this.items.filter((item) => item.kind === "steer");
    const queued: QueueDisplayItem[] = serverItems.map((entry) => ({
      id: `q-${entry.position}`,
      kind: "queued" as const,
      position: entry.position,
      text: String(entry.message ?? ""),
      displayText: String(entry.displayText ?? entry.message ?? ""),
      files: [],
    }));
    this.items = [...queued, ...steers];
    this.paused = !!snapshot?.paused;
    this.#clampFocus();
  }

  // ── Mutations (queued items go through the API) ───────────────────────────

  /** Append a server-side queued item. Returns the canonical item or null on
   *  failure. We do a fresh list() after POST instead of awaiting `refresh()`
   *  — refresh's in-flight-promise coalescing would otherwise hand us back a
   *  snapshot taken *before* our insert if another refresh was already
   *  in-flight (very easy to hit during rapid double-queue clicks). */
  enqueueQueued = ({
    message = "",
    displayText = "",
  }: { message?: string; displayText?: string } = {}) => {
    if (!this.#api) return null;
    return this.#api.add(message, displayText).then(
      (item: QueueItem) =>
        this.#api?.list().then((snapshot) => {
          this.#mergeServerSnapshot(snapshot);
          return {
            id: `q-${item.position}`,
            kind: "queued" as const,
            position: item.position,
            text: item.message || message,
            displayText: item.displayText || displayText || message,
          };
        }) ?? null,
      () => null,
    );
  };

  /** Push a transient steer chip (browser-only, never persisted). */
  pushSteer = (item: { readonly text?: string; readonly displayText?: string }) => {
    this.items.push({
      id: `s-${++this.#steerSeq}-${Date.now().toString(36)}`,
      kind: "steer",
      text: String(item.text ?? ""),
      displayText: String(item.displayText ?? item.text ?? ""),
    });
    this.#clampFocus();
  };

  clearSteers = () => {
    if (this.steerCount === 0) return;
    this.items = this.items.filter((item) => item.kind !== "steer");
    this.#clampFocus();
  };

  /** Remove an item by id. Queued items are also removed on the server. */
  removeById = (id: string): boolean | Promise<boolean> => {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return false;
    const item = this.items[idx];
    if (!item) return false;
    const next = this.items.slice();
    next.splice(idx, 1);
    this.items = next;
    if (this.focusIndex >= this.items.length) this.focusIndex = this.items.length - 1;
    else if (idx < this.focusIndex) this.focusIndex -= 1;
    if (item.kind === "queued" && this.#api && Number.isInteger(item.position)) {
      return this.#api.remove(item.position).then(
        () => true,
        () => true,
      );
    }
    return true;
  };

  /** Remove and return an item by id without touching the server. The runtime
   *  uses this when it has already removed the row server-side (e.g., sendNow
   *  is implemented as "remove + send via /api/chat"). */
  takeLocalById = (id: string): QueueDisplayItem | null => {
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx < 0) return null;
    const item = this.items[idx];
    const next = this.items.slice();
    next.splice(idx, 1);
    this.items = next;
    if (this.focusIndex >= this.items.length) this.focusIndex = this.items.length - 1;
    else if (idx < this.focusIndex) this.focusIndex -= 1;
    return item ?? null;
  };

  setPaused = (value: boolean): void | Promise<void> => {
    const next = !!value;
    if (this.paused === next) return;
    this.paused = next;
    if (this.#api) {
      return this.#api.setPaused(next).then(
        () => undefined,
        () => undefined,
      );
    }
  };

  togglePaused = () => this.setPaused(!this.paused);

  setFocusIndex = (index: number) => {
    if (!Number.isInteger(index)) return;
    if (index < 0 || this.items.length === 0) {
      this.focusIndex = -1;
      return;
    }
    this.focusIndex = Math.min(this.items.length - 1, index);
  };

  focusUp = () => {
    if (this.items.length === 0) return;
    if (this.focusIndex <= 0) this.focusIndex = this.items.length - 1;
    else this.focusIndex -= 1;
  };

  focusDown = () => {
    if (this.items.length === 0) return;
    if (this.focusIndex < 0 || this.focusIndex >= this.items.length - 1) this.focusIndex = 0;
    else this.focusIndex += 1;
  };

  focusedItem = () => {
    if (this.focusIndex < 0 || this.focusIndex >= this.items.length) return null;
    return this.items[this.focusIndex];
  };

  #clampFocus() {
    if (this.items.length === 0) {
      this.focusIndex = -1;
      return;
    }
    if (this.focusIndex >= this.items.length) this.focusIndex = this.items.length - 1;
  }
}
