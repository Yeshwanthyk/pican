import { Effect, Fiber, Schema } from "effect";
import type { ApiError } from "../lib/errors";
import type { FetchLike } from "../lib/http";
import * as Http from "../lib/http";
import { runFork, runPromise } from "../lib/runtime";

const SessionPrefetchSchema = Schema.Unknown;
export type SessionPrefetch = unknown;

type SessionPrefetchFiber = Fiber.Fiber<SessionPrefetch, ApiError>;
const inflight = new Map<string, SessionPrefetchFiber>();
const MAX_ENTRIES = 16;

export function prefetchSession(
  id: string,
  { fetchImpl = globalThis.fetch }: { readonly fetchImpl?: FetchLike } = {},
): void {
  if (!id || inflight.has(id)) return;
  if (inflight.size >= MAX_ENTRIES) {
    const oldest = inflight.keys().next().value;
    if (oldest) inflight.delete(oldest);
  }
  const url = `/api/session?id=${encodeURIComponent(id)}&paginate=1`;
  const request = Http.get(url, SessionPrefetchSchema, { fetchImpl }).pipe(
    Effect.tapError(() => Effect.sync(() => inflight.delete(id))),
  );
  inflight.set(id, runFork(request));
}

export function consumeSessionPrefetch(id: string): Promise<SessionPrefetch> | null {
  if (!id) return null;
  const fiber = inflight.get(id);
  if (!fiber) return null;
  inflight.delete(id);
  return runPromise(Fiber.join(fiber));
}

export function resetSessionPrefetch(): void {
  inflight.forEach((fiber) => runFork(Fiber.interrupt(fiber)));
  inflight.clear();
}
