import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createFollowScrollController, type FollowScrollState } from "./live-follow.js";

function setup({
  scrollHeight = 2000,
  innerHeight = 1000,
  initialState,
  onStateCapture,
}: {
  readonly scrollHeight?: number;
  readonly innerHeight?: number;
  readonly initialState?: FollowScrollState;
  readonly onStateCapture?: (state: FollowScrollState) => void;
} = {}) {
  const dom = new JSDOM('<body><main id="content"></main></body>');
  const documentImpl = dom.window.document;
  Object.defineProperty(documentImpl.documentElement, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(documentImpl.body, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });

  const handlers: Record<string, EventListener[]> = {};
  const windowImpl = {
    scrollY: 0,
    pageYOffset: 0,
    innerHeight,
    scrollTo: vi.fn(),
    setTimeout: (cb: () => void) => {
      cb();
      return 0;
    },
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    },
    addEventListener: (type: string, handler: EventListener) => {
      (handlers[type] ||= []).push(handler);
    },
    removeEventListener: (type: string, handler: EventListener) => {
      handlers[type] = (handlers[type] || []).filter((h) => h !== handler);
    },
  };
  const fire = (type: string, extra: { readonly key?: string } = {}) => {
    const event =
      type === "keydown"
        ? new dom.window.KeyboardEvent(type, { key: extra.key })
        : new dom.window.Event(type);
    (handlers[type] || []).forEach((handler) => handler(event));
  };

  const controller = createFollowScrollController({
    documentImpl,
    windowImpl,
    requestAnimationFrameImpl: (cb) => {
      cb(0);
      return 0;
    },
    setTimeoutImpl: (cb) => {
      cb();
      return 0;
    },
    initialState,
    onStateCapture,
  });
  return { dom, documentImpl, windowImpl, handlers, fire, controller };
}

describe("createFollowScrollController", () => {
  it("starts following and scrolls to bottom on init", () => {
    const { windowImpl, controller } = setup();
    expect(controller.isFollowing()).toBe(true);
    expect(controller.shouldFollow()).toBe(true);
    expect(windowImpl.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("restores an exact non-follow transcript position after layout", () => {
    const onStateCapture = vi.fn();
    const { documentImpl, controller } = setup({
      initialState: { scrollTop: 417.5, following: false },
      onStateCapture,
    });

    expect(documentImpl.getElementById("content")?.scrollTop).toBe(417.5);
    expect(controller.isFollowing()).toBe(false);
    expect(documentImpl.querySelector(".follow-button")).not.toBeNull();
    expect(onStateCapture).toHaveBeenLastCalledWith({ scrollTop: 417.5, following: false });
  });

  it("captures transcript scroll and follow changes", () => {
    const onStateCapture = vi.fn();
    const { documentImpl, fire, controller } = setup({ onStateCapture });
    const content = documentImpl.getElementById("content");
    expect(content).not.toBeNull();
    Object.defineProperty(content, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(content, "clientHeight", { value: 500, configurable: true });
    if (content) content.scrollTop = 321;

    fire("scroll");

    expect(controller.isFollowing()).toBe(false);
    expect(onStateCapture).toHaveBeenLastCalledWith({ scrollTop: 321, following: false });

    // A keyed teardown can clamp the old element before cleanup runs. Disposal
    // must publish the controller-owned capture, not query the tearing-down DOM.
    if (content) content.scrollTop = 0;
    controller.dispose();
    expect(onStateCapture).toHaveBeenLastCalledWith({ scrollTop: 321, following: false });
  });

  it("stops following and shows the follow button when scrolled away from bottom", () => {
    const { documentImpl, windowImpl, fire, controller } = setup();
    windowImpl.scrollY = 0; // remaining = 2000 - 0 - 1000 = 1000 (> threshold)
    fire("scroll");
    expect(controller.isFollowing()).toBe(false);
    expect(documentImpl.querySelector(".follow-button")).not.toBeNull();
  });

  it("keeps following on a downward scrollTop clamp that stays at the bottom", () => {
    const { documentImpl, windowImpl, fire, controller } = setup();
    windowImpl.scrollY = 1000; // remaining = 2000 - 1000 - 1000 = 0 (at bottom)
    fire("scroll");
    expect(controller.isFollowing()).toBe(true);
    // The document shrinks when the streaming preview is finalized/removed, so
    // the browser clamps scrollTop downward — but we are still at the bottom.
    windowImpl.scrollY = 960; // remaining = 40 (< 80 threshold, still at bottom)
    fire("scroll");
    expect(controller.isFollowing()).toBe(true);
    expect(documentImpl.querySelector(".follow-button")).toBeNull();
  });

  it("releases forced follow when the user scrolls up away from the bottom", () => {
    const { windowImpl, fire, controller } = setup();
    windowImpl.scrollY = 1000;
    fire("scroll");
    controller.extendPreviewFollow(30000);
    expect(controller.shouldFollow()).toBe(true);
    windowImpl.scrollY = 0; // remaining = 1000 (away from bottom) and scrolled up
    fire("scroll");
    expect(controller.isFollowing()).toBe(false);
    expect(controller.shouldFollow()).toBe(false);
  });

  it("clicking the follow button re-follows and removes the button", () => {
    const { documentImpl, windowImpl, fire, controller } = setup();
    fire("scroll");
    const btn = documentImpl.querySelector<HTMLButtonElement>(".follow-button");
    expect(btn).not.toBeNull();
    windowImpl.scrollTo.mockClear();
    btn?.click();
    expect(windowImpl.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
    expect(documentImpl.querySelector(".follow-button")).toBeNull();
    expect(controller.isFollowing()).toBe(true);
  });

  it("renders a live pending count on the follow button and resets it on click", () => {
    const { documentImpl, windowImpl, fire, controller } = setup();
    fire("scroll"); // scrolled away from bottom → button appears
    const btn = documentImpl.querySelector<HTMLButtonElement>(".follow-button");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-label")).toBe("Scroll to bottom");

    controller.incrementPending(3);
    expect(btn?.querySelector(".follow-button-count")?.textContent).toBe("3");
    expect(btn?.getAttribute("aria-label")).toBe("Scroll to bottom, 3 new messages");

    // More entries stream in while the button is already visible.
    controller.incrementPending(2);
    expect(btn?.querySelector(".follow-button-count")?.textContent).toBe("5");
    expect(btn?.getAttribute("aria-label")).toBe("Scroll to bottom, 5 new messages");

    // Re-pinning clears the count and hides the button.
    btn?.click();
    expect(documentImpl.querySelector(".follow-button")).toBeNull();
    expect(controller.isFollowing()).toBe(true);

    // Scrolling away again creates a fresh button without a count.
    windowImpl.scrollY = 0;
    fire("scroll");
    const fresh = documentImpl.querySelector<HTMLButtonElement>(".follow-button");
    expect(fresh).not.toBeNull();
    expect(fresh?.querySelector(".follow-button-count")).toBeNull();
    expect(fresh?.getAttribute("aria-label")).toBe("Scroll to bottom");
  });

  it("extendPreviewFollow keeps shouldFollow true while not following", () => {
    const { fire, controller } = setup();
    fire("scroll"); // following becomes false
    expect(controller.shouldFollow()).toBe(false);
    controller.extendPreviewFollow(30000);
    expect(controller.shouldFollow()).toBe(true);
  });

  it("forceFollowToBottom re-follows and scrolls", () => {
    const { windowImpl, fire, controller } = setup();
    fire("scroll");
    expect(controller.isFollowing()).toBe(false);
    windowImpl.scrollTo.mockClear();
    controller.forceFollowToBottom(true);
    expect(controller.isFollowing()).toBe(true);
    expect(windowImpl.scrollTo).toHaveBeenCalled();
  });

  it("ignores non-scrolling keys for follow decisions", () => {
    const { fire, controller } = setup();
    fire("keydown", { key: "a" });
    expect(controller.isFollowing()).toBe(true);
  });

  it("dispose removes listeners so later scrolls no longer change state", () => {
    const { fire, controller } = setup();
    controller.dispose();
    fire("scroll");
    expect(controller.isFollowing()).toBe(true);
  });
});
