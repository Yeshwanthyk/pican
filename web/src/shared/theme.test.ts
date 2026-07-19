import { describe, expect, it } from "vitest";
import { applyTheme, THEME_IDS, toggleTheme } from "./theme.js";

function fakeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  };
}

interface FakeThemeRoot {
  readonly dataset: Record<string, string | undefined>;
  readonly style: { backgroundColor?: string };
}

function fakeDocument() {
  const root: FakeThemeRoot = { dataset: {}, style: {} };
  const meta = { content: "" };
  return {
    documentElement: root,
    cookie: "",
    querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? meta : null),
    _meta: meta,
  };
}

describe("theme helpers", () => {
  it("applies and persists the custom theme selection", () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = { localStorage: storage, navigator: {} };

    applyTheme(windowImpl, documentImpl, "custom");

    expect(documentImpl.documentElement.dataset.theme).toBe("custom");
    expect(storage.getItem("pican-theme")).toBe("custom");
    expect(documentImpl.cookie).toContain("pican-theme=custom");
  });

  it("uses the custom theme --body-bg for the page surround", () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = {
      localStorage: storage,
      navigator: {},
      getComputedStyle: () => ({ getPropertyValue: () => "  #1a1b26  " }),
    };

    applyTheme(windowImpl, documentImpl, "custom");

    expect(documentImpl.documentElement.style.backgroundColor).toBe("#1a1b26");
    expect(documentImpl._meta.content).toBe("#1a1b26");
  });

  it("uses the active community theme chrome variable in window-controls-overlay mode", () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = {
      localStorage: storage,
      navigator: { windowControlsOverlay: { visible: true } },
      getComputedStyle: () => ({
        getPropertyValue: (property: string) => (property === "--chrome-bg" ? "  #181825  " : ""),
      }),
    };

    applyTheme(windowImpl, documentImpl, "catppuccin-mocha");

    expect(documentImpl.documentElement.style.backgroundColor).toBe("#181825");
    expect(documentImpl._meta.content).toBe("#181825");
  });

  it("falls back to the dark background when custom defines no --body-bg", () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = {
      localStorage: storage,
      navigator: {},
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
    };

    applyTheme(windowImpl, documentImpl, "custom");

    expect(documentImpl.documentElement.style.backgroundColor).toBe("#111116");
  });

  it("cycles from dracula to custom", () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = { localStorage: storage, navigator: {} };
    documentImpl.documentElement.dataset.theme = "dracula";

    toggleTheme(windowImpl, documentImpl);

    expect(documentImpl.documentElement.dataset.theme).toBe("custom");
    expect(storage.getItem("pican-theme")).toBe("custom");
  });

  it("cycles through the full theme registry and wraps to dark", () => {
    const storage = fakeStorage();
    const documentImpl = fakeDocument();
    const windowImpl = { localStorage: storage, navigator: {} };
    documentImpl.documentElement.dataset.theme = "kanagawa-wave";

    toggleTheme(windowImpl, documentImpl);

    expect(THEME_IDS).toHaveLength(15);
    expect(documentImpl.documentElement.dataset.theme).toBe("dark");
  });
});
