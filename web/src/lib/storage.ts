import { Effect, Schema } from "effect";
import { StorageError } from "./errors";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const decodeWith = Schema.decodeUnknownEffect;
const storageEffect = (
  key: string,
  storage?: StorageLike,
): Effect.Effect<StorageLike, StorageError> =>
  storage !== undefined
    ? Effect.succeed(storage)
    : Effect.try({
        try: () => globalThis.localStorage,
        catch: (cause) => new StorageError({ key, op: "read", cause }),
      }).pipe(
        Effect.flatMap((target) =>
          target === undefined
            ? Effect.fail(new StorageError({ key, op: "read", cause: "unavailable" }))
            : Effect.succeed(target),
        ),
      );

export const getJson = <A, R>(
  key: string,
  schema: Schema.ConstraintDecoder<A, R>,
  storage?: StorageLike,
): Effect.Effect<A | undefined, StorageError, R> =>
  storageEffect(key, storage).pipe(
    Effect.flatMap((target) =>
      Effect.try({
        try: () => target.getItem(key),
        catch: (cause) => new StorageError({ key, op: "read", cause }),
      }),
    ),
    Effect.flatMap((raw) => {
      if (raw === null) return Effect.succeed(undefined);
      return decodeWith(Schema.fromJsonString(schema))(raw).pipe(
        Effect.mapError((cause) => new StorageError({ key, op: "parse", cause })),
      );
    }),
  );

export const setJson = <A, I, RD, RE>(
  key: string,
  value: A,
  schema: Schema.ConstraintCodec<A, I, RD, RE>,
  storage?: StorageLike,
): Effect.Effect<void, StorageError, RE> =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError((cause) => new StorageError({ key, op: "parse", cause })),
    Effect.flatMap((raw) =>
      storageEffect(key, storage).pipe(
        Effect.mapError((error) => new StorageError({ key, op: "write", cause: error.cause })),
        Effect.flatMap((target) =>
          Effect.try({
            try: () => target.setItem(key, raw),
            catch: (cause) => new StorageError({ key, op: "write", cause }),
          }),
        ),
      ),
    ),
  );

export const getJsonOr = <A, R>(
  key: string,
  schema: Schema.ConstraintDecoder<A, R>,
  fallback: A,
  storage?: StorageLike,
): Effect.Effect<A, never, R> =>
  getJson(key, schema, storage).pipe(
    Effect.map((value) => value ?? fallback),
    Effect.catch(() => Effect.succeed(fallback)),
  );

export const setJsonBestEffort = <A, I, RD, RE>(
  key: string,
  value: A,
  schema: Schema.ConstraintCodec<A, I, RD, RE>,
  storage?: StorageLike,
): Effect.Effect<void, never, RE> =>
  setJson(key, value, schema, storage).pipe(Effect.catch(() => Effect.void));
