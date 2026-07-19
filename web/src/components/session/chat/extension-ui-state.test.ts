import { assert, describe, expect, it } from "vitest";
import { reducePendingExtensionUI } from "./extension-ui-state.js";

describe("reducePendingExtensionUI", () => {
  it("adds, dedupes, and resolves requests", () => {
    let state = reducePendingExtensionUI(
      [],
      { type: "add", request: { id: "a", title: "First" } },
      100,
    );
    state = reducePendingExtensionUI(state, { type: "add", request: { id: "b" } }, 110);
    state = reducePendingExtensionUI(
      state,
      { type: "add", request: { id: "a", title: "Updated" } },
      120,
    );
    expect(state.map((request) => request.id)).toEqual(["a", "b"]);
    const first = state[0];
    assert(first);
    expect(first.title).toBe("Updated");
    expect(
      reducePendingExtensionUI(state, { type: "resolve", id: "a" }, 130).map(
        (request) => request.id,
      ),
    ).toEqual(["b"]);
  });

  it("drops timed-out requests", () => {
    const state = reducePendingExtensionUI(
      [],
      { type: "add", request: { id: "a", timeout: 50 } },
      100,
    );
    expect(reducePendingExtensionUI(state, { type: "prune" }, 149)).toHaveLength(1);
    expect(reducePendingExtensionUI(state, { type: "prune" }, 150)).toHaveLength(0);
  });
});
