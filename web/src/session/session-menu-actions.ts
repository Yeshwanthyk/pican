import { Schema } from "effect";
import type { FetchLike } from "../lib/http";
import { runPromise } from "../lib/runtime";
import { getJSON, postJSON } from "../shared/api.js";

// Network actions behind the session command menu, split out of CommandMenu so
// the component keeps only UI orchestration (open/close, toast, navigate) and
// these stay unit-testable in isolation.

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const EntriesResponseSchema = Schema.StructWithRest(
  Schema.Struct({ entries: Schema.optionalKey(Schema.Array(UnknownRecord)) }),
  [UnknownRecord],
);
const MutationResponseSchema = Schema.StructWithRest(Schema.Struct({}), [UnknownRecord]);
const decodeEntries = Schema.decodeUnknownEffect(EntriesResponseSchema);
const decodeMutation = Schema.decodeUnknownEffect(MutationResponseSchema);

interface ActionOptions {
  readonly fetchImpl?: FetchLike;
}

const sessionUrl = (path: string, id: string): string => `${path}?id=${encodeURIComponent(id)}`;

export async function renameSession(
  sessionId: string,
  name: string,
  { fetchImpl = globalThis.fetch }: ActionOptions = {},
) {
  const payload = await postJSON(
    "/api/rename-session?id=" + encodeURIComponent(sessionId),
    { name },
    { fetchImpl },
  );
  return runPromise(decodeMutation(payload));
}

// Fetches fresh entries — the in-memory model is stale after a live reload.
export async function loadForkEntries(
  sessionId: string,
  { fetchImpl = globalThis.fetch }: ActionOptions = {},
) {
  const payload = await getJSON(sessionUrl("/api/session", sessionId), { fetchImpl });
  const data = await runPromise(decodeEntries(payload));
  return data.entries ?? [];
}

export async function forkSession(
  sessionId: string,
  entryId: string,
  { fetchImpl = globalThis.fetch }: ActionOptions = {},
) {
  const payload = await postJSON(
    sessionUrl("/api/fork-session", sessionId),
    { entryId },
    { fetchImpl },
  );
  return runPromise(decodeMutation(payload));
}

export async function cloneSession(
  sessionId: string,
  { fetchImpl = globalThis.fetch }: ActionOptions = {},
) {
  const payload = await postJSON(sessionUrl("/api/clone-session", sessionId), {}, { fetchImpl });
  return runPromise(decodeMutation(payload));
}

export async function regenerateTitle(
  sessionId: string,
  { fetchImpl = globalThis.fetch }: ActionOptions = {},
) {
  const payload = await postJSON(
    "/api/regenerate-title?id=" + encodeURIComponent(sessionId),
    {},
    { fetchImpl },
  );
  return runPromise(decodeMutation(payload));
}
