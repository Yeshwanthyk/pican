import { navigate } from "./navigation.js";
import type { NavigationWindow } from "./navigation.js";

const SCROLL_AMOUNT = 300;
const GG_TIMEOUT = 500; // ms window for double-tap 'gg'

/**
 * Returns true when the element is an input, textarea, select, or
 * contenteditable region where the user types text.
 */
export interface KeyboardElement {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly style?: { readonly display?: string };
  readonly scrollHeight?: number;
  closest?(selector: string): unknown;
  blur?(): void;
  focus?(): void;
  scrollBy?(options: ScrollToOptions): void;
  scrollTo?(options: ScrollToOptions): void;
}

export interface KeyboardEvent {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface KeyboardDocument {
  readonly activeElement: KeyboardElement | null;
  readonly documentElement: { readonly scrollHeight: number };
  addEventListener(
    type: "keydown",
    handler: (event: KeyboardEvent) => void,
    options?: { readonly capture?: boolean },
  ): void;
  removeEventListener(
    type: "keydown",
    handler: (event: KeyboardEvent) => void,
    options?: { readonly capture?: boolean },
  ): void;
  querySelector(selector: string): KeyboardElement | null;
  querySelectorAll?(selector: string): Iterable<KeyboardElement>;
  getElementById?(id: string): KeyboardElement | null;
}

export interface KeyboardWindow extends NavigationWindow {
  scrollBy(options: ScrollToOptions): void;
  scrollTo(options: ScrollToOptions): void;
}

interface KeyboardNavOptions {
  readonly windowImpl?: KeyboardWindow;
  readonly documentImpl?: KeyboardDocument;
  readonly setTimeoutImpl?: (callback: () => void, millis: number) => unknown;
  readonly clearTimeoutImpl?: (timer: unknown) => void;
  readonly focusSelector?: string;
}

export function isEditableTarget(element: KeyboardElement | null | undefined): boolean {
  if (!element) return false;
  const tagName = element.tagName;
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return element.isContentEditable || Boolean(element.closest?.('[contenteditable="true"]'));
}

/**
 * Returns true when a composer autocomplete popup (slash palette or @mention
 * file list) is currently displayed. These popups handle their own Escape via
 * the composer keydown listener, so document-level nav must not intercept it.
 */
export function isComposerPopupOpen(
  documentImpl: Pick<KeyboardDocument, "querySelectorAll"> = document,
): boolean {
  const popups = documentImpl.querySelectorAll?.("#pi-chat-slash-popup, #pi-chat-mention-popup");
  if (!popups) return false;
  for (const popup of popups) {
    const display = popup.style?.display;
    if (display && display !== "none") return true;
  }
  return false;
}

/**
 * Installs vim-style document-level keyboard navigation:
 *
 * 1. <kbd>Escape</kbd> blurs the active editable element so the user
 *    can then use the nav keys.
 * 2. <kbd>j</kbd> / <kbd>k</kbd> scroll down/up by SCROLL_AMOUNT px.
 * 3. <kbd>g g</kbd> (double-tap) scrolls to the very top of the page.
 * 4. <kbd>G</kbd> (shift+g) scrolls to the very bottom of the page.
 * 5. <kbd>I</kbd> (shift+i) focuses the main input box (chat composer).
 *
 * All scrolls use instant (no animation) for snappy vim-like feel.
 */
export function setupKeyboardNav({
  windowImpl = window,
  documentImpl = document,
  setTimeoutImpl = (callback, millis) => setTimeout(callback, millis),
  clearTimeoutImpl = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  focusSelector = "#pi-chat-message",
}: KeyboardNavOptions = {}): () => void {
  let ggTimer: unknown | null = null;

  // Capture phase so Escape blurs the main input *before* bubble-phase
  // handlers see the event — but only when the user isn't inside a popup
  // or modal that has its own Escape handling (model popup, palette, etc.).
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      const active = documentImpl.activeElement;
      if (!isEditableTarget(active)) return;
      if (!active) return;
      // Don't steal Escape from popups / modals / overlays.
      if (
        active.closest?.(
          '.pi-chat-model-popup, .pi-chat-thinking-popup, [role="menu"], [role="dialog"], .command-menu-popover, .mobile-command-panel, .share-overlay-backdrop, .mobile-command-backdrop, #commandPalette, #sessionPalette, .model-selector-dropdown, .modal-overlay, .modal',
        )
      )
        return;
      // The slash and @mention popups anchor to the main composer textarea (a
      // sibling, not an ancestor), so closest() above can't see them. When one
      // is open, let Escape bubble to the composer's own close handler instead
      // of blurring the textarea.
      if (isComposerPopupOpen(documentImpl)) return;
      e.preventDefault();
      e.stopPropagation();
      active?.blur?.();
    }
  };

  // Cmd/Ctrl+, opens the global settings page (standard macOS preferences
  // shortcut). Works regardless of focus, like a native app.
  const onSettingsShortcut = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === ",") {
      e.preventDefault();
      navigate("/settings", { windowImpl });
    }
  };

  const onNavigate = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditableTarget(documentImpl.activeElement)) return;

    if (e.key === "j") {
      e.preventDefault();
      const content =
        typeof documentImpl.getElementById === "function"
          ? documentImpl.getElementById("content")
          : null;
      if (content) {
        content.scrollBy?.({ top: SCROLL_AMOUNT, behavior: "instant" });
      } else {
        windowImpl.scrollBy({ top: SCROLL_AMOUNT, behavior: "instant" });
      }
    } else if (e.key === "k") {
      e.preventDefault();
      const content =
        typeof documentImpl.getElementById === "function"
          ? documentImpl.getElementById("content")
          : null;
      if (content) {
        content.scrollBy?.({ top: -SCROLL_AMOUNT, behavior: "instant" });
      } else {
        windowImpl.scrollBy({ top: -SCROLL_AMOUNT, behavior: "instant" });
      }
    } else if (e.key === "g") {
      e.preventDefault();
      if (ggTimer) {
        // Second 'g' within timeout — scroll to top
        clearTimeoutImpl(ggTimer);
        ggTimer = null;
        const content =
          typeof documentImpl.getElementById === "function"
            ? documentImpl.getElementById("content")
            : null;
        if (content) {
          content.scrollTo?.({ top: 0, behavior: "instant" });
        } else {
          windowImpl.scrollTo({ top: 0, behavior: "instant" });
        }
      } else {
        // First 'g' — start the double-tap window
        ggTimer = setTimeoutImpl(() => {
          ggTimer = null;
        }, GG_TIMEOUT);
      }
    } else if (e.key === "G") {
      e.preventDefault();
      const content =
        typeof documentImpl.getElementById === "function"
          ? documentImpl.getElementById("content")
          : null;
      if (content) {
        content.scrollTo?.({ top: content.scrollHeight, behavior: "instant" });
      } else {
        windowImpl.scrollTo({
          top: documentImpl.documentElement.scrollHeight,
          behavior: "instant",
        });
      }
    } else if (e.key === "I") {
      e.preventDefault();
      const el = documentImpl.querySelector(focusSelector);
      el?.focus?.();
    }
  };

  const captureOptions = { capture: true } as const;
  documentImpl.addEventListener("keydown", onEscape, captureOptions);
  documentImpl.addEventListener("keydown", onSettingsShortcut);
  documentImpl.addEventListener("keydown", onNavigate);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (ggTimer) {
      clearTimeoutImpl(ggTimer);
      ggTimer = null;
    }
    documentImpl.removeEventListener("keydown", onEscape, captureOptions);
    documentImpl.removeEventListener("keydown", onSettingsShortcut);
    documentImpl.removeEventListener("keydown", onNavigate);
  };
}
