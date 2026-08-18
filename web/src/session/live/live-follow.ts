import {
  createFollowButton,
  isAtBottom,
  removeFollowButton,
  scrollElementAboveComposer,
  scrollToBottom,
  setFollowButtonText,
} from "./live-scroll.js";
import { Option, Schema } from "effect";

interface FollowWindow {
  scrollY: number;
  readonly pageYOffset: number;
  readonly innerHeight: number;
  scrollTo(options: ScrollToOptions): void;
  setTimeout(handler: () => void, timeout?: number): unknown;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  addEventListener(type: string, handler: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(
    type: string,
    handler: EventListener,
    options?: AddEventListenerOptions,
  ): void;
}

const KeyboardEventSchema = Schema.Struct({ key: Schema.String });
const decodeKeyboardEvent = Schema.decodeUnknownOption(KeyboardEventSchema);

export interface FollowScrollState {
  readonly scrollTop: number;
  readonly following: boolean;
}

// Owns the follow-scroll decision state for the live session viewer: whether we
// auto-stick to the bottom as new entries stream in, the floating "scroll to
// bottom" button, the pending-entry counter, and the short window after a sent
// message during which we keep following the streaming preview. Extracted from
// LiveReload.svelte so the decision logic is unit-testable in isolation; the
// scroll primitives still default to the real document/window in production.
export function createFollowScrollController({
  documentImpl = document,
  windowImpl = window,
  requestAnimationFrameImpl = windowImpl.requestAnimationFrame.bind(windowImpl),
  setTimeoutImpl = windowImpl.setTimeout.bind(windowImpl),
  initialState,
  onStateCapture = () => {},
}: {
  readonly documentImpl?: Document;
  readonly windowImpl?: FollowWindow;
  readonly requestAnimationFrameImpl?: (callback: FrameRequestCallback) => number | void;
  readonly setTimeoutImpl?: (handler: () => void, timeout?: number) => unknown;
  readonly initialState?: FollowScrollState;
  readonly onStateCapture?: (state: FollowScrollState) => void;
} = {}) {
  const scrollImpls = { documentImpl, windowImpl };
  let following = initialState?.following ?? true;
  let followBtn: HTMLButtonElement | null = null;
  let pendingCount = 0;
  let forcePreviewFollowUntil = 0;
  let lastScrollTop = 0;
  let lastCapturedScrollTop = initialState?.scrollTop ?? 0;
  let lastCapturedFollowing = initialState?.following ?? true;
  let restoring = initialState !== undefined;
  let disposed = false;
  const contentEl = documentImpl.getElementById("content");
  const cleanups: Array<() => void> = [];
  const on = (
    host: Pick<EventTarget, "addEventListener" | "removeEventListener">,
    type: string,
    handler: EventListener,
    opts?: AddEventListenerOptions,
  ): void => {
    host.addEventListener(type, handler, opts);
    cleanups.push(() => host.removeEventListener(type, handler, opts));
  };

  function showFollowButton(): void {
    if (followBtn) return;
    followBtn = createFollowButton({
      documentImpl,
      requestAnimationFrameImpl,
      onClick: () => {
        following = true;
        pendingCount = 0;
        scrollToBottom(true, scrollImpls);
        hideFollowButton();
        captureState();
      },
    });
    setFollowButtonText(followBtn, pendingCount);
  }
  function hideFollowButton(): void {
    if (!followBtn) return;
    removeFollowButton(followBtn, { windowImpl });
    followBtn = null;
  }

  function getScrollPosition(): number {
    let scrolled =
      windowImpl.scrollY ||
      windowImpl.pageYOffset ||
      documentImpl.documentElement.scrollTop ||
      documentImpl.body.scrollTop;
    if (contentEl && contentEl.scrollHeight > contentEl.clientHeight) {
      scrolled = Math.max(scrolled, contentEl.scrollTop);
    }
    return scrolled;
  }
  function captureState(): FollowScrollState {
    const state =
      restoring && initialState
        ? initialState
        : {
            scrollTop: contentEl ? contentEl.scrollTop : getScrollPosition(),
            following,
          };
    lastCapturedScrollTop = state.scrollTop;
    lastCapturedFollowing = state.following;
    onStateCapture(state);
    return state;
  }
  function publishLastCapturedState(): FollowScrollState {
    const state = { scrollTop: lastCapturedScrollTop, following: lastCapturedFollowing };
    onStateCapture(state);
    return state;
  }
  lastScrollTop = getScrollPosition();

  function disableFollowOnUserInteraction(event: Event): void {
    if (event.type === "keydown") {
      const scrollingKeys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
      const key = Option.getOrElse(decodeKeyboardEvent(event), () => ({ key: "" })).key;
      if (scrollingKeys.indexOf(key) === -1) return;
    }
    forcePreviewFollowUntil = 0;
    if (isAtBottom(scrollImpls)) {
      following = true;
      hideFollowButton();
    } else {
      following = false;
      showFollowButton();
    }
    captureState();
  }

  function onScroll(): void {
    if (restoring) return;
    const currentScroll = getScrollPosition();
    const scrolledUp = currentScroll < lastScrollTop;
    lastScrollTop = currentScroll;
    const atBottom = isAtBottom(scrollImpls);
    following = atBottom;
    if (scrolledUp && !atBottom) {
      // User manually scrolled up and away from the bottom; release the forced
      // follow so they can read previous messages without being yanked back
      // down. A downward scrollTop clamp (the browser shrinking the document
      // when a streaming preview is finalized/removed) also decreases scrollTop
      // but leaves us pinned at the bottom — that must not release follow, or
      // the "scroll to bottom" button wrongly appears when the agent finishes.
      forcePreviewFollowUntil = 0;
      following = false;
    }
    if (following) {
      hideFollowButton();
      pendingCount = 0;
    } else {
      showFollowButton();
    }
    captureState();
  }

  function scrollAfterLayout(smooth: boolean, target?: Element | null): void {
    requestAnimationFrameImpl(() => {
      scrollElementAboveComposer(target, !!smooth, scrollImpls);
      setTimeoutImpl(() => {
        scrollElementAboveComposer(target, !!smooth, scrollImpls);
      }, 40);
    });
  }
  function forceFollowToBottom(smooth: boolean): void {
    following = true;
    pendingCount = 0;
    hideFollowButton();
    scrollAfterLayout(!!smooth);
    captureState();
  }

  on(windowImpl, "scroll", onScroll, { passive: true });
  if (contentEl) on(contentEl, "scroll", onScroll, { passive: true });
  on(windowImpl, "wheel", disableFollowOnUserInteraction, { passive: true });
  on(windowImpl, "touchmove", disableFollowOnUserInteraction, { passive: true });
  on(windowImpl, "keydown", disableFollowOnUserInteraction, { passive: true });

  if (initialState) {
    const restoreInitialState = (): void => {
      following = initialState.following;
      if (following) {
        scrollToBottom(false, scrollImpls);
        hideFollowButton();
      } else {
        if (contentEl) contentEl.scrollTop = initialState.scrollTop;
        else windowImpl.scrollTo({ top: initialState.scrollTop, behavior: "auto" });
        showFollowButton();
      }
      lastScrollTop = getScrollPosition();
    };
    // SessionPage's initial navigator also schedules a bottom scroll. Restore
    // after that fresh model render, then once more after layout settles.
    requestAnimationFrameImpl(() => {
      if (disposed) return;
      restoreInitialState();
      setTimeoutImpl(() => {
        if (disposed) return;
        restoreInitialState();
        // Large transcripts can finish their reactive DOM/layout after the
        // page runtime's first navigation pass. One final bounded retry avoids
        // the browser clamping an early scrollTop assignment to zero.
        setTimeoutImpl(() => {
          if (disposed) return;
          restoreInitialState();
          restoring = false;
          captureState();
        }, 200);
      }, 40);
    });
  } else {
    scrollToBottom(false, scrollImpls);
  }

  return {
    isFollowing: () => following,
    isAtBottom: () => isAtBottom(scrollImpls),
    shouldFollow: () => following || Date.now() < forcePreviewFollowUntil,
    extendPreviewFollow: (ms = 30000): void => {
      forcePreviewFollowUntil = Date.now() + ms;
    },
    incrementPending: (count: number): void => {
      pendingCount += count;
      // showFollowButton renders the button text only once, so keep the visible
      // button's pending count current as more entries stream in while the user
      // stays scrolled away from the bottom.
      if (followBtn) setFollowButtonText(followBtn, pendingCount);
    },
    showFollowButton,
    forceFollowToBottom,
    scrollAfterLayout,
    captureState,
    dispose: () => {
      // DOM teardown may already have clamped the detached pane to zero. Use
      // the controller-owned last capture rather than querying during unmount.
      publishLastCapturedState();
      disposed = true;
      for (const fn of cleanups) fn();
      followBtn?.remove();
      followBtn = null;
    },
  };
}
