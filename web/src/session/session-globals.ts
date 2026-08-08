// Page-global wiring for the live session view. Called once by <SessionPage>
// after the model + navigateTo are ready. Everything here is live-only
// (notifications/clipboard/keyboard/mobile viewport) and never runs in the
// static export.
//
// Covers: done-notifier, keyboard navigation, global keyboard shortcuts, and
// the mobile visual-viewport / scroll-lock handlers.

import * as doneNotifier from "./chat/done-notifier.js";
import { openSessionPalette } from "../shared/command-palette-runtime.js";
import { setupKeyboardNav } from "../shared/keyboard-nav.js";
import { openShortcuts, toggleTree } from "./session-modals.svelte.js";
import { sessionRuntime } from "./session-runtime.js";
import { toggleTheme, syncThemeIcons } from "../shared/theme.js";

export function setupSessionGlobals({
  windowImpl,
  documentImpl,
}: {
  readonly windowImpl: Window & typeof globalThis;
  readonly documentImpl: Document;
}): () => void {
  const target = windowImpl;

  // Track the listeners we add directly so the SPA can tear them down on
  // unmount (and tests stay isolated). Helpers like the version checker /
  // palette manage their own lifecycles.
  const cleanups: Array<() => void> = [];
  const on = (
    host: (Window & typeof globalThis) | Document | VisualViewport | HTMLElement,
    type: string,
    handler: (event: Event) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void => {
    host.addEventListener(type, handler, opts);
    cleanups.push(() => host.removeEventListener(type, handler, opts));
  };

  // Done-notifier (desktop notification + app badge when a worker finishes).
  cleanups.push(doneNotifier.setupDoneNotifyToggle({ documentImpl, windowImpl: target }));
  cleanups.push(doneNotifier.setupAppBadgeClearing({ documentImpl, windowImpl: target }));
  on(target, "pi-worker-done", () => {
    doneNotifier.notifyDone({ documentImpl, windowImpl: target });
  });

  cleanups.push(setupKeyboardNav({ windowImpl: target, documentImpl }));

  // Session list palette (Cmd+K / "List Sessions" menu item). The Svelte
  // <CommandPalette> component owns the palette and registers its API in
  // command-palette-runtime.

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  // Cmd+K — session list palette
  on(target, "keydown", (e) => {
    if (!(e instanceof KeyboardEvent)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openSessionPalette();
    }
  });

  // Cmd+B — toggle the session tree overlay
  on(target, "keydown", (e) => {
    if (!(e instanceof KeyboardEvent)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleTree();
    }
  });

  // Cmd+T — new session
  on(target, "keydown", (e) => {
    if (!(e instanceof KeyboardEvent)) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "t") {
      e.preventDefault();
      const newBtn = documentImpl.getElementById("new-btn");
      if (newBtn) newBtn.click();
    }
  });

  // Cmd+Shift+L — system theme toggle. Capture phase so the browser doesn't
  // swallow it before we see it.
  on(
    target,
    "keydown",
    (e) => {
      if (!(e instanceof KeyboardEvent)) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        e.stopPropagation();
        toggleTheme(
          {
            localStorage: target.localStorage,
            getComputedStyle: () => target.getComputedStyle(documentImpl.documentElement),
          },
          documentImpl,
        );
        syncThemeIcons(documentImpl);
      }
    },
    { capture: true },
  );

  // Cmd+Shift+N — toggle scratchpad (right sidebar)
  on(target, "keydown", (e) => {
    if (!(e instanceof KeyboardEvent)) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      sessionRuntime.rightSidebar?.toggle?.();
    }
  });

  // Cmd+/ — keyboard shortcuts help modal (the <ShortcutsModal> Svelte
  // component, opened via the shared sessionModals store).
  on(target, "keydown", (e) => {
    if (!(e instanceof KeyboardEvent)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "/") {
      e.preventDefault();
      openShortcuts();
    }
  });

  const shortcutsBtn = documentImpl.getElementById("shortcuts-help-btn");
  if (shortcutsBtn) {
    on(shortcutsBtn, "click", (e) => {
      e.stopPropagation();
      openShortcuts();
    });
  }

  const newSessionHeaderBtn = documentImpl.getElementById("new-session-header-btn");
  if (newSessionHeaderBtn) {
    on(newSessionHeaderBtn, "click", (e) => {
      e.stopPropagation();
      documentImpl.getElementById("new-btn")?.click();
    });
  }

  // Visual Viewport handling — keep the fixed top header in view when the mobile
  // virtual keyboard opens.
  const visualViewport = target.visualViewport;
  if (visualViewport) {
    const handleVisualViewportChange = () => {
      const height = visualViewport.height;
      documentImpl.documentElement.style.setProperty("--viewport-height", `${height}px`);
      const offsetTop = Math.max(0, visualViewport.offsetTop);
      const header = documentImpl.querySelector<HTMLElement>(".session-header-bar");
      if (header) header.style.transform = `translateY(${offsetTop}px)`;
    };
    on(visualViewport, "resize", handleVisualViewportChange);
    on(visualViewport, "scroll", handleVisualViewportChange);
    handleVisualViewportChange();
  }

  // Prevent the mobile browser from auto-scrolling the layout viewport when the
  // keyboard opens.
  on(target, "scroll", () => {
    if (target.scrollY !== 0 || target.scrollX !== 0) target.scrollTo(0, 0);
  });
  on(documentImpl, "scroll", () => {
    if (
      documentImpl.documentElement.scrollTop !== 0 ||
      documentImpl.documentElement.scrollLeft !== 0
    ) {
      documentImpl.documentElement.scrollTop = 0;
      documentImpl.documentElement.scrollLeft = 0;
    }
    if (documentImpl.body.scrollTop !== 0 || documentImpl.body.scrollLeft !== 0) {
      documentImpl.body.scrollTop = 0;
      documentImpl.body.scrollLeft = 0;
    }
  });

  return () => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  };
}
