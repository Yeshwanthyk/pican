import { describe, expect, it } from "vitest";
import { SessionSwitchStateCache } from "./session-switch-state.js";

describe("SessionSwitchStateCache", () => {
  it("merges independent capture contracts without normalizing composer text", () => {
    const cache = new SessionSwitchStateCache();

    cache.update("alpha", { composerText: "  exact draft\nnext line  " });
    cache.update("alpha", { transcriptScrollTop: 417.5, following: false });

    expect(cache.get("alpha")).toEqual({
      composerText: "  exact draft\nnext line  ",
      transcriptScrollTop: 417.5,
      following: false,
    });
  });

  it("evicts the least recently used session at its bound", () => {
    const cache = new SessionSwitchStateCache(3);
    cache.update("alpha", { composerText: "a" });
    cache.update("beta", { composerText: "b" });
    cache.update("gamma", { composerText: "c" });

    expect(cache.get("alpha")?.composerText).toBe("a"); // alpha is now most recent
    cache.update("delta", { composerText: "d" });

    expect(cache.size).toBe(3);
    expect(cache.get("beta")).toBeUndefined();
    expect(cache.get("gamma")?.composerText).toBe("c");
    expect(cache.get("alpha")?.composerText).toBe("a");
    expect(cache.get("delta")?.composerText).toBe("d");
  });

  it("returns snapshots rather than mutable cache entries", () => {
    const cache = new SessionSwitchStateCache();
    cache.update("alpha", { composerText: "saved" });

    const snapshot = cache.get("alpha");
    Object.assign(snapshot ?? {}, { composerText: "mutated" });

    expect(cache.get("alpha")?.composerText).toBe("saved");
  });

  it("falls back to the default bound for an invalid capacity", () => {
    const cache = new SessionSwitchStateCache(0);
    for (let index = 0; index < 17; index += 1) {
      cache.update(`session-${index}`, { composerText: String(index) });
    }
    expect(cache.size).toBe(16);
    expect(cache.get("session-0")).toBeUndefined();
  });
});
