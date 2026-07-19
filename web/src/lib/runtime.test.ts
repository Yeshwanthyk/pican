import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { effectResource, runPromise, runSync } from "./runtime";

describe("runtime bridge", () => {
  it("runs effects and publishes resource states", async () => {
    await expect(runPromise(Effect.succeed(4))).resolves.toBe(4);
    expect(runSync(Effect.succeed(3))).toBe(3);
    const resource = effectResource(Effect.succeed("ready"));
    const states: Array<string> = [];
    const unsubscribe = resource.subscribe((state) => states.push(state.state));
    await viWait();
    expect(states).toContain("ok");
    unsubscribe();
    resource.dispose();
  });

  it("does not let an interrupted generation overwrite a newer refresh", async () => {
    const resumes: Array<(effect: Effect.Effect<string>) => void> = [];
    const resource = effectResource(
      Effect.callback<string>((resume) => {
        resumes.push(resume);
      }),
    );
    const values: Array<string> = [];
    resource.subscribe((state) => {
      if (state.state === "ok") values.push(state.value);
    });
    resource.refresh();
    resumes[1]?.(Effect.succeed("new"));
    resumes[0]?.(Effect.succeed("old"));
    await viWait();
    expect(values).toEqual(["new"]);
    resource.dispose();
  });
});

const viWait = () => new Promise<void>((resolve) => queueMicrotask(resolve));
