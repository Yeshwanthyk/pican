import { Effect } from "effect";
import type { RequestOptions } from "../lib/http";
import * as Http from "../lib/http";
import { NewSessionResponseSchema } from "../lib/schema";

export interface CreateSessionBody {
  readonly path: string;
  readonly runtime?: string;
  readonly sourceSessionId?: string;
  readonly initialPrompt?: string;
}

const pendingIntentKeys = new Map<string, string>();

const fingerprint = (body: CreateSessionBody): string =>
  JSON.stringify({
    path: body.path,
    runtime: body.runtime || "pi",
    sourceSessionId: body.sourceSessionId || "",
    initialPrompt: body.initialPrompt || "",
  });

// A failed request retains its key so a user retry converges on the same
// durable server mapping. Success clears it so the next deliberate create is
// a fresh intent, even with the same payload.
export function createSessionEffect(body: CreateSessionBody, options: RequestOptions = {}) {
  const intent = fingerprint(body);
  const key = pendingIntentKeys.get(intent) ?? globalThis.crypto.randomUUID();
  pendingIntentKeys.set(intent, key);
  return Http.post("/api/new-session", body, NewSessionResponseSchema, {
    ...options,
    headers: { ...options.headers, "Idempotency-Key": key },
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        if (pendingIntentKeys.get(intent) === key) pendingIntentKeys.delete(intent);
      }),
    ),
  );
}
