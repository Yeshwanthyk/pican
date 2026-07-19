import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { effectResource, runPromise } from "./runtime";

describe("runtime bridge", () => {
  it("runs effects and publishes resource states", async () => {
    await expect(runPromise(Effect.succeed(4))).resolves.toBe(4);
    const resource = effectResource(Effect.succeed("ready"));
    const states: Array<string> = [];
    const unsubscribe = resource.subscribe((state) => states.push(state.state));
    await viWait();
    expect(states).toContain("ok");
    unsubscribe();
    resource.dispose();
  });
});

const viWait = () => new Promise<void>((resolve) => queueMicrotask(resolve));
