import { Effect, Fiber, Schema } from "effect";
import type { ApiError } from "../lib/errors";
import type { FetchLike } from "../lib/http";
import * as Http from "../lib/http";
import { runFork, runPromise } from "../lib/runtime";

const SessionPrefetchSchema = Schema.Unknown;
export type SessionPrefetch = unknown;

type SessionPrefetchFiber = Fiber.Fiber<SessionPrefetch, ApiError>;
type PrefetchEntry =
  | {
      readonly requestId: symbol;
      readonly state: "prefetched";
      readonly fiber: SessionPrefetchFiber;
    }
  | {
      readonly requestId: symbol;
      readonly state: "consumed";
      readonly fiber: SessionPrefetchFiber;
      readonly promise: Promise<SessionPrefetch>;
    };

const entries = new Map<string, PrefetchEntry>();
const MAX_ENTRIES = 16;

function removeRequest(id: string, requestId: symbol): void {
  if (entries.get(id)?.requestId === requestId) entries.delete(id);
}

function interrupt(entry: PrefetchEntry): void {
  runFork(Fiber.interrupt(entry.fiber));
}

function evictOldestPrefetch(): boolean {
  for (const [id, entry] of entries) {
    // Once consumed, this request is serving navigation rather than speculative
    // work. Never abort an active page load to make room for another hover.
    if (entry.state === "consumed") continue;
    entries.delete(id);
    interrupt(entry);
    return true;
  }
  return false;
}

export function prefetchSession(
  id: string,
  { fetchImpl = globalThis.fetch }: { readonly fetchImpl?: FetchLike } = {},
): void {
  if (!id || entries.has(id)) return;
  if (entries.size >= MAX_ENTRIES && !evictOldestPrefetch()) return;

  const requestId = Symbol(id);
  const url = `/api/session?id=${encodeURIComponent(id)}&paginate=1`;
  const request = Http.get(url, SessionPrefetchSchema, { fetchImpl }).pipe(
    Effect.tapError(() => Effect.sync(() => removeRequest(id, requestId))),
  );
  entries.set(id, { requestId, state: "prefetched", fiber: runFork(request) });
}

export function consumeSessionPrefetch(id: string): Promise<SessionPrefetch> | null {
  if (!id) return null;
  const entry = entries.get(id);
  if (!entry) return null;
  if (entry.state === "consumed") return entry.promise;

  const promise = runPromise(Fiber.join(entry.fiber)).finally(() => {
    removeRequest(id, entry.requestId);
  });
  entries.set(id, { ...entry, state: "consumed", promise });
  return promise;
}

export function resetSessionPrefetch(): void {
  const pending = [...entries.values()];
  entries.clear();
  pending.forEach(interrupt);
}
