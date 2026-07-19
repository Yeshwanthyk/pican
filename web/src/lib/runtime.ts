import { Effect, Layer, ManagedRuntime } from "effect";
import type { Fiber } from "effect";

export type ResourceState<A, E> =
  | { readonly state: "loading" }
  | { readonly state: "ok"; readonly value: A }
  | { readonly state: "error"; readonly error: E };

export interface EffectResource<A, E> {
  subscribe(listener: (state: ResourceState<A, E>) => void): () => void;
  refresh(): void;
  dispose(): void;
}

const appRuntime = ManagedRuntime.make(Layer.empty);

export const runPromise = <A, E>(
  effect: Effect.Effect<A, E>,
  options?: { readonly signal?: AbortSignal },
): Promise<A> => appRuntime.runPromise(effect, options);

export const runFork = <A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> =>
  appRuntime.runFork(effect);

export const runSync = <A, E>(effect: Effect.Effect<A, E>): A => appRuntime.runSync(effect);

export const effectResource = <A, E>(effect: Effect.Effect<A, E>): EffectResource<A, E> => {
  let state: ResourceState<A, E> = { state: "loading" };
  const listeners = new Set<(next: ResourceState<A, E>) => void>();
  let interrupt: (() => void) | undefined;
  let generation = 0;
  const publish = (next: ResourceState<A, E>) => {
    state = next;
    listeners.forEach((listener) => listener(next));
  };
  const refresh = () => {
    const currentGeneration = ++generation;
    interrupt?.();
    publish({ state: "loading" });
    const observed = effect.pipe(
      Effect.match({
        onFailure: (error) => {
          if (generation === currentGeneration) publish({ state: "error", error });
        },
        onSuccess: (value) => {
          if (generation === currentGeneration) publish({ state: "ok", value });
        },
      }),
    );
    interrupt = appRuntime.runCallback(observed, { onExit: () => undefined });
  };
  refresh();
  return {
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    dispose() {
      generation += 1;
      interrupt?.();
      listeners.clear();
    },
  };
};
