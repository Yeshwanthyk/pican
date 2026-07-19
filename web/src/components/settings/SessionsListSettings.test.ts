import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import SessionsListSettings from "./SessionsListSettings.svelte";

afterEach(cleanup);

describe("SessionsListSettings", () => {
  it("offers the complete activity indicator set", () => {
    render(SessionsListSettings);

    const select = document.querySelector<HTMLSelectElement>(
      '[data-setting="pican:spinner-style"]',
    );
    expect(Array.from(select?.options ?? [], ({ value, text }) => [value, text])).toEqual([
      ["runcat", "Runcat"],
      ["braille", "Braille"],
      ["pacman", "Pac-Man"],
      ["comet", "Comet"],
    ]);
  });
});
