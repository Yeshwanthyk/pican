import { assert, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { Option, Schema } from "effect";
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
import {
  BTW_GEOM_KEY,
  enableBtwDrag,
  loadBtwGeometry,
  persistBtwResize,
  placeBtwInitial,
  saveBtwGeometry,
} from "./btw-geometry.js";

function storageMock(initial: Readonly<Record<string, string>> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    data,
  };
}

describe("btw geometry", () => {
  it("loads and merges persisted geometry", () => {
    const storage = storageMock({ [BTW_GEOM_KEY]: JSON.stringify({ left: 10, top: 20 }) });
    expect(loadBtwGeometry({ storage })).toEqual({ left: 10, top: 20 });

    saveBtwGeometry({ width: 360 }, { storage });
    const stored = storage.data.get(BTW_GEOM_KEY);
    assert(stored);
    const decoded = decodeJson(stored);
    expect(Option.getOrNull(decoded)).toEqual({ left: 10, top: 20, width: 360 });
  });

  it("returns null for invalid storage data", () => {
    const storage = storageMock({ [BTW_GEOM_KEY]: "{bad" });
    expect(loadBtwGeometry({ storage })).toBe(null);
  });

  it("places from persisted coordinates when available", () => {
    const dom = new JSDOM('<body><div id="root"></div></body>');
    const root = dom.window.document.getElementById("root");
    assert(root);
    const saveGeometry = vi.fn();
    placeBtwInitial(root, {
      windowImpl: dom.window,
      loadGeometry: () => ({ left: 12, top: 34 }),
      saveGeometry,
    });
    expect(root.style.left).toBe("12px");
    expect(root.style.top).toBe("34px");
    expect(saveGeometry).not.toHaveBeenCalled();
  });

  it("centers near the bottom and saves coordinates when no geometry exists", () => {
    const dom = new JSDOM('<body><div id="root"></div></body>');
    const root = dom.window.document.getElementById("root");
    assert(root);
    root.getBoundingClientRect = () => DOMRect.fromRect({ width: 300, height: 200 });
    const saveGeometry = vi.fn();

    placeBtwInitial(root, {
      windowImpl: { innerWidth: 900, innerHeight: 700 },
      loadGeometry: () => null,
      saveGeometry,
    });

    expect(root.style.left).toBe("300px");
    expect(root.style.top).toBe("410px");
    expect(saveGeometry).toHaveBeenCalledWith({ left: 300, top: 410 });
  });

  it("drags within viewport bounds and ignores action buttons", () => {
    const dom = new JSDOM(
      '<body><div id="root"><div id="handle"><div class="pi-btw-actions"><button id="action"></button></div></div></div></body>',
    );
    const root = dom.window.document.getElementById("root");
    const handle = dom.window.document.getElementById("handle");
    const action = dom.window.document.getElementById("action");
    assert(root);
    assert(handle);
    assert(action);
    root.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 80, width: 200, height: 150 });
    const saveGeometry = vi.fn();
    vi.stubGlobal("Element", dom.window.Element);

    enableBtwDrag(root, handle, {
      documentImpl: dom.window.document,
      windowImpl: { innerWidth: 250, innerHeight: 180 },
      saveGeometry,
    });

    action.dispatchEvent(
      new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    dom.window.document.dispatchEvent(
      new dom.window.MouseEvent("pointermove", { clientX: 200, clientY: 200 }),
    );
    expect(saveGeometry).not.toHaveBeenCalled();

    handle.dispatchEvent(
      new dom.window.MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 80 }),
    );
    dom.window.document.dispatchEvent(
      new dom.window.MouseEvent("pointermove", { clientX: 300, clientY: 300 }),
    );
    expect(root.style.left).toBe("50px");
    expect(root.style.top).toBe("30px");
    expect(saveGeometry).toHaveBeenCalledWith({ left: 50, top: 30 });
    vi.unstubAllGlobals();
  });

  it("persists dimensions from ResizeObserver", () => {
    const dom = new JSDOM('<body><div id="root"></div></body>');
    const root = dom.window.document.getElementById("root");
    assert(root);
    Object.defineProperty(root, "offsetWidth", { value: 420 });
    Object.defineProperty(root, "offsetHeight", { value: 260 });
    const saveGeometry = vi.fn();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class FakeResizeObserver implements ResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }

    persistBtwResize(root, {
      windowImpl: {
        ResizeObserver: FakeResizeObserver,
        requestAnimationFrame: (cb: FrameRequestCallback) => {
          cb(0);
          return 1;
        },
        cancelAnimationFrame: vi.fn(),
      },
      saveGeometry,
    });
    const resizeCallback = resizeCallbacks[0];
    assert(resizeCallback);
    resizeCallback([], new FakeResizeObserver(resizeCallback));

    expect(saveGeometry).toHaveBeenCalledWith({ width: 420, height: 260 });
  });
});
