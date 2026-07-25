import { SvelteSet } from "svelte/reactivity";
import type { SessionList } from "../lib/schema";
import {
  defaultFetchSessions,
  defaultUpdatePin,
  normalizeSession,
  type NormalizedSession,
} from "../index/sessions";
import { createStatusEvents, type StatusEventsOptions } from "../shared/status-events";

const RELOAD_THROTTLE_MS = 5_000;

interface StatusSubscription {
  connect(): void;
  cleanup(): void;
}

type CreateStatusEvents = (options?: StatusEventsOptions) => StatusSubscription;

export interface PinnedTabsDependencies {
  readonly fetchHome?: () => Promise<SessionList>;
  readonly updatePin?: (sessionId: string, pinned: boolean) => Promise<unknown>;
  readonly createEvents?: CreateStatusEvents;
  readonly now?: () => number;
  readonly setTimeoutImpl?: typeof globalThis.setTimeout;
  readonly clearTimeoutImpl?: typeof globalThis.clearTimeout;
}

export function pinnedSessionsFromCatalog(
  catalog: SessionList["sessions"] = [],
): NormalizedSession[] {
  return catalog
    .map((session) => normalizeSession(session))
    .filter((session) => session.pinned && !session.archived)
    .sort(
      (a, b) => (a.pinOrder || Number.MAX_SAFE_INTEGER) - (b.pinOrder || Number.MAX_SAFE_INTEGER),
    );
}

export function selectVisiblePinnedSessions(
  sessions: ReadonlyArray<NormalizedSession>,
  currentSessionId: string,
  limit: number,
): NormalizedSession[] {
  if (limit <= 0) return [];
  if (sessions.length <= limit) return [...sessions];
  const visible = sessions.slice(0, limit);
  const current = sessions.find((session) => session.id === currentSessionId);
  if (!current || visible.some((session) => session.id === current.id)) return visible;
  visible[visible.length - 1] = current;
  return visible;
}

export class PinnedTabsModel {
  sessions = $state<NormalizedSession[]>([]);
  runningIds = new SvelteSet<string>();
  busyIds = new SvelteSet<string>();
  loading = $state(false);
  loadFailed = $state(false);

  #currentSessionId: string;
  #enabled = false;
  #subscription: StatusSubscription | null = null;
  #pendingLoad: Promise<boolean> | null = null;
  #lastReloadAt = Number.NEGATIVE_INFINITY;
  #reloadTimer: ReturnType<typeof setTimeout> | null = null;
  #fetchHome: () => Promise<SessionList>;
  #updatePin: (sessionId: string, pinned: boolean) => Promise<unknown>;
  #createEvents: CreateStatusEvents;
  #now: () => number;
  #setTimeout: typeof globalThis.setTimeout;
  #clearTimeout: typeof globalThis.clearTimeout;

  constructor(currentSessionId: string, dependencies: PinnedTabsDependencies = {}) {
    this.#currentSessionId = currentSessionId;
    this.#fetchHome = dependencies.fetchHome ?? (() => defaultFetchSessions({ view: "home" }));
    this.#updatePin = dependencies.updatePin ?? defaultUpdatePin;
    this.#createEvents = dependencies.createEvents ?? createStatusEvents;
    this.#now = dependencies.now ?? Date.now;
    this.#setTimeout = dependencies.setTimeoutImpl ?? globalThis.setTimeout;
    this.#clearTimeout = dependencies.clearTimeoutImpl ?? globalThis.clearTimeout;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get currentSessionId(): string {
    return this.#currentSessionId;
  }

  setCurrentSessionId(sessionId: string): void {
    this.#currentSessionId = sessionId;
  }

  isPinned(sessionId: string): boolean {
    return this.sessions.some((session) => session.id === sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.runningIds.has(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.busyIds.has(sessionId);
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) {
      this.#disconnect();
      return;
    }
    void this.load();
    this.#connect();
  }

  load(): Promise<boolean> {
    if (this.#pendingLoad) return this.#pendingLoad;
    this.loading = true;
    this.loadFailed = false;
    this.#pendingLoad = this.#fetchHome()
      .then(
        (response) => {
          this.sessions = pinnedSessionsFromCatalog(response.sessions);
          return true;
        },
        () => {
          this.loadFailed = true;
          return false;
        },
      )
      .finally(() => {
        this.loading = false;
        this.#pendingLoad = null;
      });
    return this.#pendingLoad;
  }

  async setPinned(session: NormalizedSession, pinned: boolean): Promise<boolean> {
    if (!session.id || this.busyIds.has(session.id)) return false;
    const previous = [...this.sessions];
    this.busyIds.add(session.id);
    if (pinned) {
      const maxOrder = this.sessions.reduce(
        (maximum, item) => Math.max(maximum, item.pinOrder || 0),
        0,
      );
      this.sessions = pinnedSessionsFromCatalog([
        ...this.sessions,
        { ...session, pinned: true, archived: false, pinOrder: maxOrder + 1 },
      ]);
    } else {
      this.sessions = this.sessions.filter((item) => item.id !== session.id);
    }

    try {
      await this.#updatePin(session.id, pinned);
      await this.load();
      return true;
    } catch {
      this.sessions = previous;
      return false;
    } finally {
      this.busyIds.delete(session.id);
    }
  }

  dispose(): void {
    this.#enabled = false;
    this.#disconnect();
  }

  #connect(): void {
    if (this.#subscription) return;
    this.#subscription = this.#createEvents({
      topic: "__all__",
      onSnapshot: ({ ids }) => {
        this.runningIds.clear();
        for (const id of ids) this.runningIds.add(id);
      },
      onDelta: ({ id, running }) => {
        if (running) this.runningIds.add(id);
        else this.runningIds.delete(id);
      },
      onMessage: (message) => {
        if (message === "new-session") void this.load();
      },
      onReload: ({ id }) => this.#handleReload(id),
      onCurationUpdate: () => {
        void this.load();
      },
      onReconnect: () => {
        void this.load();
      },
    });
    this.#subscription.connect();
  }

  #disconnect(): void {
    this.#subscription?.cleanup();
    this.#subscription = null;
    if (this.#reloadTimer !== null) {
      this.#clearTimeout(this.#reloadTimer);
      this.#reloadTimer = null;
    }
  }

  #handleReload(id: string): void {
    if (!id || (id !== this.#currentSessionId && !this.isPinned(id))) return;
    const elapsed = this.#now() - this.#lastReloadAt;
    if (elapsed >= RELOAD_THROTTLE_MS) {
      this.#lastReloadAt = this.#now();
      void this.load();
      return;
    }
    if (this.#reloadTimer !== null) return;
    this.#reloadTimer = this.#setTimeout(() => {
      this.#reloadTimer = null;
      if (!this.#enabled) return;
      this.#lastReloadAt = this.#now();
      void this.load();
    }, RELOAD_THROTTLE_MS - elapsed);
  }
}
