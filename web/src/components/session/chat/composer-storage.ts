import { Effect } from "effect";
import { runSync } from "../../../lib/runtime";

export function getComposerStorage({ windowImpl = window }: { windowImpl?: Window } = {}) {
  return runSync(
    Effect.try({
      try: () => windowImpl.localStorage,
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null))),
  );
}
