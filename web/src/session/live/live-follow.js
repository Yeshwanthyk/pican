import {
  createFollowButton,
  isAtBottom,
  removeFollowButton,
  scrollElementAboveComposer,
  scrollToBottom,
  setFollowButtonText,
} from './live-scroll.js';

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
} = {}) {
  const scrollImpls = { documentImpl, windowImpl };
  let following = true;
  let followBtn = null;
  let pendingCount = 0;
  let forcePreviewFollowUntil = 0;
  let lastScrollTop = 0;
  const contentEl = documentImpl.getElementById('content');
  const cleanups = [];
  const on = (host, type, handler, opts) => {
    host.addEventListener(type, handler, opts);
    cleanups.push(() => host.removeEventListener(type, handler, opts));
  };

  function showFollowButton() {
    if (followBtn) return;
    followBtn = createFollowButton({
      documentImpl,
      requestAnimationFrameImpl,
      onClick: () => {
        following = true;
        pendingCount = 0;
        scrollToBottom(true, scrollImpls);
        hideFollowButton();
      },
    });
    setFollowButtonText(followBtn, pendingCount);
  }
  function hideFollowButton() {
    if (!followBtn) return;
    removeFollowButton(followBtn, { windowImpl });
    followBtn = null;
  }

  function getScrollPosition() {
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
  lastScrollTop = getScrollPosition();

  function disableFollowOnUserInteraction(e) {
    if (e.type === 'keydown') {
      const scrollingKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];
      if (scrollingKeys.indexOf(e.key) === -1) return;
    }
    forcePreviewFollowUntil = 0;
    if (isAtBottom(scrollImpls)) {
      following = true;
      hideFollowButton();
    } else {
      following = false;
      showFollowButton();
    }
  }

  function onScroll() {
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
  }

  function scrollAfterLayout(smooth, target) {
    requestAnimationFrameImpl(() => {
      scrollElementAboveComposer(target, !!smooth, scrollImpls);
      setTimeoutImpl(() => {
        scrollElementAboveComposer(target, !!smooth, scrollImpls);
      }, 40);
    });
  }
  function forceFollowToBottom(smooth) {
    following = true;
    pendingCount = 0;
    hideFollowButton();
    scrollAfterLayout(!!smooth);
  }

  on(windowImpl, 'scroll', onScroll, { passive: true });
  if (contentEl) on(contentEl, 'scroll', onScroll, { passive: true });
  on(windowImpl, 'wheel', disableFollowOnUserInteraction, { passive: true });
  on(windowImpl, 'touchmove', disableFollowOnUserInteraction, { passive: true });
  on(windowImpl, 'keydown', disableFollowOnUserInteraction, { passive: true });

  scrollToBottom(false, scrollImpls);

  return {
    isFollowing: () => following,
    isAtBottom: () => isAtBottom(scrollImpls),
    shouldFollow: () => following || Date.now() < forcePreviewFollowUntil,
    extendPreviewFollow: (ms = 30000) => {
      forcePreviewFollowUntil = Date.now() + ms;
    },
    incrementPending: (count) => {
      pendingCount += count;
    },
    showFollowButton,
    forceFollowToBottom,
    scrollAfterLayout,
    dispose: () => {
      for (const fn of cleanups) fn();
    },
  };
}
