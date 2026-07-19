import { describe, expect, it, vi } from "vitest";
import { setupComposerExpansion } from "./composer-expand.js";

function createParts() {
  const shell = document.createElement("div");
  const expandButton = document.createElement("button");
  const textarea = document.createElement("textarea");
  textarea.focus = vi.fn();
  return { shell, expandButton, textarea };
}

function createStorage(entries: ReadonlyArray<readonly [string, string]> = []) {
  const values = new Map<string, string>(entries);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe("setupComposerExpansion", () => {
  it("restores expanded state from session-scoped storage", () => {
    const parts = createParts();
    const storage = createStorage([["pican:chat:composer-expanded:abc", "1"]]);

    setupComposerExpansion({ sessionId: "abc", ...parts, storage });

    expect(parts.shell.classList.contains("expanded")).toBe(true);
    expect(parts.expandButton.getAttribute("aria-pressed")).toBe("true");
    expect(parts.expandButton.getAttribute("aria-label")).toBe("Collapse composer");
  });

  it("toggles and persists state on click", () => {
    const parts = createParts();
    const storage = createStorage();
    const onHeightChange = vi.fn();

    setupComposerExpansion({ sessionId: "abc", ...parts, storage, onHeightChange });
    parts.expandButton.click();

    expect(parts.shell.classList.contains("expanded")).toBe(true);
    expect(storage.values.get("pican:chat:composer-expanded:abc")).toBe("1");
    expect(parts.textarea.focus).toHaveBeenCalled();
    expect(onHeightChange).toHaveBeenCalled();

    parts.expandButton.click();
    expect(parts.shell.classList.contains("expanded")).toBe(false);
    expect(storage.values.get("pican:chat:composer-expanded:abc")).toBe("0");
  });
});
