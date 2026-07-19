import * as Http from "../../../lib/http";
import { runPromise } from "../../../lib/runtime";
import {
  QueueItemSchema,
  QueuePauseResponseSchema,
  QueueRemoveResponseSchema,
  QueueStateSchema,
} from "../../../lib/schema";
import type { QueueItem, QueueState } from "../../../lib/schema";

export interface QueueApi {
  list(): Promise<QueueState>;
  add(message: string, displayText: string): Promise<QueueItem>;
  remove(position: number): Promise<{ readonly ok: true; readonly removed: boolean }>;
  setPaused(paused: boolean): Promise<{ readonly ok: true; readonly paused: boolean }>;
}

interface QueueApiOptions {
  readonly sessionId: string;
  readonly fetchImpl?: Http.FetchLike;
}

const queueUrl = (sessionId: string, position?: number) => {
  const params = new URLSearchParams({ id: sessionId });
  if (position !== undefined) params.set("position", String(position));
  return `/api/chat/queue?${params.toString()}`;
};

export function createQueueApi({
  sessionId,
  fetchImpl = globalThis.fetch,
}: QueueApiOptions): QueueApi {
  const base = queueUrl(sessionId);
  const options = { fetchImpl } as const;
  return {
    list: () => runPromise(Http.get(base, QueueStateSchema, options)),
    add: (message, displayText) =>
      runPromise(Http.post(base, { message, displayText }, QueueItemSchema, options)),
    remove: (position) =>
      runPromise(Http.del(queueUrl(sessionId, position), QueueRemoveResponseSchema, options)),
    setPaused: (paused) =>
      runPromise(Http.patch(base, { paused }, QueuePauseResponseSchema, options)),
  };
}
