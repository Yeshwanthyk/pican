import { Effect, Schema } from "effect";
import { runSync } from "../lib/runtime";
import { getJson, setJson } from "../lib/storage";

export function loadJSON(key: string, fallback: unknown): unknown {
  return runSync(
    getJson(key, Schema.Unknown).pipe(
      Effect.map((value) => value ?? fallback),
      Effect.catch(() => Effect.succeed(fallback)),
    ),
  );
}

export function saveJSON(key: string, value: unknown): void {
  runSync(setJson(key, value, Schema.Unknown).pipe(Effect.catch(() => Effect.void)));
}
