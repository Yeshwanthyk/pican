import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPromise } from "./runtime";
import { getJson, getJsonOr, setJson } from "./storage";

afterEach(() => vi.unstubAllGlobals());

describe("localStorage effects", () => {
  it("round-trips schema-validated JSON", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    await runPromise(setJson("n", 2, Schema.Number, storage));
    await expect(runPromise(getJson("n", Schema.Number, storage))).resolves.toBe(2);
  });

  it("degrades parse failures to the supplied default", async () => {
    const storage = { getItem: () => "bad", setItem: () => undefined };
    await expect(runPromise(getJsonOr("n", Schema.Number, 7, storage))).resolves.toBe(7);
  });

  it("types unavailable storage and encode failures", async () => {
    vi.stubGlobal("localStorage", undefined);
    await expect(runPromise(Effect.flip(getJson("n", Schema.Number)))).resolves.toMatchObject({
      _tag: "StorageError",
      op: "read",
    });
    const storage = { getItem: () => null, setItem: () => undefined };
    await expect(
      runPromise(Effect.flip(setJson("n", "", Schema.NonEmptyString, storage))),
    ).resolves.toMatchObject({ _tag: "StorageError", op: "parse" });
  });
});
