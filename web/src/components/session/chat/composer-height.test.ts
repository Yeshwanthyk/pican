import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { setupComposerHeightVar } from "./composer-height.js";

function makeForm(height = 42.2): HTMLFormElement {
  document.body.innerHTML = '<form id="pi-chat-composer"></form>';
  const form = document.querySelector<HTMLFormElement>("#pi-chat-composer");
  assert(form);
  vi.spyOn(form, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ height }));
  return form;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("setupComposerHeightVar", () => {
  it("sets the composer height CSS variable immediately", () => {
    setupComposerHeightVar({ documentImpl: document, windowImpl: window, form: makeForm(42.2) });

    expect(document.documentElement.style.getPropertyValue("--pi-chat-composer-height")).toBe(
      "43px",
    );
  });

  it("updates when the window resize listener fires", () => {
    const form = makeForm(10);
    setupComposerHeightVar({ documentImpl: document, windowImpl: window, form });
    vi.mocked(form.getBoundingClientRect).mockReturnValue(DOMRect.fromRect({ height: 55.1 }));
    window.dispatchEvent(new Event("resize"));

    expect(document.documentElement.style.getPropertyValue("--pi-chat-composer-height")).toBe(
      "56px",
    );
  });

  it("observes the form when ResizeObserver is available", () => {
    const form = makeForm(12);
    const observe = vi.fn();
    const constructorCallback = vi.fn();
    class FakeResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        constructorCallback(callback);
        callback([], this);
      }
      observe = observe;
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    setupComposerHeightVar({
      documentImpl: document,
      windowImpl: window,
      form,
      ResizeObserverImpl: FakeResizeObserver,
    });

    expect(constructorCallback).toHaveBeenCalledWith(expect.any(Function));
    expect(observe).toHaveBeenCalledWith(form);
  });
});
