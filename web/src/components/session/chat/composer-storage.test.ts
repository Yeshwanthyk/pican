import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { getComposerStorage } from "./composer-storage.js";

describe("getComposerStorage", () => {
  it("returns window localStorage when accessible", () => {
    const storage = window.localStorage;

    expect(getComposerStorage({ windowImpl: window })).toBe(storage);
  });

  it("returns null when localStorage access throws", () => {
    const windowImpl = Object.create(window);
    Object.defineProperty(windowImpl, "localStorage", {
      get() {
        return Effect.runSync(Effect.die("blocked"));
      },
    });

    expect(getComposerStorage({ windowImpl })).toBe(null);
  });
});
