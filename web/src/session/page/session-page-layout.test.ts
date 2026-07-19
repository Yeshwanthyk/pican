import { afterEach, describe, expect, it, vi } from "vitest";
import { applySessionPageBodyClasses, applyStoredSessionLayout } from "./session-page-layout.js";

describe("session page layout helpers", () => {
  afterEach(() => {
    document.documentElement.className = "";
    document.body.className = "";
    document.documentElement.removeAttribute("style");
    vi.restoreAllMocks();
  });

  it("adds and removes the session page body classes", () => {
    const dispose = applySessionPageBodyClasses({ documentImpl: document });
    expect(document.documentElement.classList.contains("pican-session-page")).toBe(true);
    expect(document.body.classList.contains("pican-session-page")).toBe(true);

    dispose();

    expect(document.documentElement.classList.contains("pican-session-page")).toBe(false);
    expect(document.body.classList.contains("pican-session-page")).toBe(false);
  });

  it("applies stored right-sidebar state", () => {
    const storage = new Map([["pican:v1:right-sidebar-width", "456"]]);
    const windowImpl = {
      matchMedia: vi.fn(() => ({ matches: true })),
    };

    applyStoredSessionLayout({
      documentImpl: document,
      windowImpl,
      storage: { getItem: (key) => storage.get(key) ?? null },
    });

    expect(document.body.classList.contains("right-sidebar-collapsed")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--right-sidebar-width")).toBe("456px");
  });
});
