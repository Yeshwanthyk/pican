import { Effect, Schema } from "effect";
import { NetworkError } from "../../lib/errors";
import { runFork, runPromise, runSync } from "../../lib/runtime";

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<ReadonlyArray<{ readonly family: string }>>;
  }

  interface Navigator {
    readonly windowControlsOverlay?: { readonly visible?: boolean };
  }
}

export type PromiseResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: NetworkError };

const MessageErrorSchema = Schema.Struct({ message: Schema.String });
const isMessageError = Schema.is(MessageErrorSchema);

const promiseEffect = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new NetworkError({ cause }),
  });

export const settle = <A>(evaluate: () => PromiseLike<A>): Promise<PromiseResult<A>> =>
  runPromise(
    promiseEffect(evaluate).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false, error }) as const,
        onSuccess: (value) => ({ ok: true, value }) as const,
      }),
    ),
  );

export const ignoreFailure = (evaluate: () => PromiseLike<unknown>): void => {
  runFork(promiseEffect(evaluate).pipe(Effect.catch(() => Effect.void)));
};

export const stringifyJson = (value: unknown): string =>
  runSync(
    Effect.try({
      try: () => JSON.stringify(value, null, 2),
      catch: () => "",
    }).pipe(Effect.catch(() => Effect.succeed(""))),
  );

export const recoverSync = <A>(evaluate: () => A, fallback: A): A =>
  runSync(
    Effect.try({ try: evaluate, catch: () => "operation failed" }).pipe(
      Effect.catch(() => Effect.succeed(fallback)),
    ),
  );

export const errorMessage = (error: NetworkError, fallback: string): string =>
  isMessageError(error.cause) ? error.cause.message : fallback;
