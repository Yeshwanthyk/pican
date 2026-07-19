import { icon, ArrowDown } from "../../shared/icons.js";

interface ScrollWindow {
  readonly innerHeight: number;
  readonly pageYOffset?: number;
  readonly scrollY?: number;
  scrollTo?(options: ScrollToOptions): void;
  setTimeout?(handler: () => void, timeout?: number): unknown;
}

interface ScrollOptions {
  readonly documentImpl?: Document;
  readonly windowImpl?: ScrollWindow;
  readonly threshold?: number;
}

export function chatComposerHeight(_options?: { readonly documentImpl?: Document }): number {
  return 0;
}

export function isAtBottom({
  documentImpl = document,
  windowImpl = window,
  threshold = 80,
}: ScrollOptions = {}): boolean {
  const de = documentImpl.documentElement;
  const body = documentImpl.body;
  const content = documentImpl.getElementById("content");

  // If the window has scrollable height, the main window is the active scroll container (Desktop).
  // Otherwise, #content is the active scroll container (Mobile).
  const isWindowScrollable = de.scrollHeight > windowImpl.innerHeight;

  if (isWindowScrollable) {
    const docHeight = Math.max(de.scrollHeight, body.scrollHeight);
    const scrolled = windowImpl.scrollY || windowImpl.pageYOffset || de.scrollTop || body.scrollTop;
    const viewport = windowImpl.innerHeight;
    const remaining = docHeight - scrolled - viewport;
    return remaining < threshold;
  }

  if (content && content.scrollHeight > content.clientHeight) {
    const contentRemaining = content.scrollHeight - content.scrollTop - content.clientHeight;
    return contentRemaining < threshold;
  }

  // Fallback to window measurements if content is not scrollable/present
  const docHeight = Math.max(de.scrollHeight, body.scrollHeight);
  const scrolled = windowImpl.scrollY || windowImpl.pageYOffset || de.scrollTop || body.scrollTop;
  const viewport = windowImpl.innerHeight;
  return docHeight - scrolled - viewport < threshold;
}

export function scrollToBottom(
  smooth: boolean,
  { documentImpl = document, windowImpl = window }: ScrollOptions = {},
): void {
  const content = documentImpl.getElementById("content");
  if (content && content.scrollHeight > content.clientHeight) {
    content.scrollTo({ top: content.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }
  windowImpl.scrollTo?.({
    top: Math.max(documentImpl.documentElement.scrollHeight, documentImpl.body.scrollHeight),
    behavior: smooth ? "smooth" : "auto",
  });
}

export function scrollElementAboveComposer(
  el: Element | null | undefined,
  smooth: boolean,
  { documentImpl = document, windowImpl = window }: ScrollOptions = {},
): void {
  if (!el) {
    scrollToBottom(smooth, { documentImpl, windowImpl });
    return;
  }
  const gap = chatComposerHeight({ documentImpl }) + 24;
  const content = documentImpl.getElementById("content");
  if (content && content.contains(el)) {
    const contentRect = content.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const delta = elRect.bottom - (contentRect.bottom - gap);
    if (delta > 0) {
      content.scrollTo({ top: content.scrollTop + delta, behavior: smooth ? "smooth" : "auto" });
    }
  }
  const rect = el.getBoundingClientRect();
  const viewportDelta = rect.bottom - (windowImpl.innerHeight - gap);
  if (viewportDelta > 0) {
    windowImpl.scrollTo?.({
      top: (windowImpl.scrollY || windowImpl.pageYOffset || 0) + viewportDelta,
      behavior: smooth ? "smooth" : "auto",
    });
  }
}

export function createFollowButton({
  documentImpl = document,
  requestAnimationFrameImpl = requestAnimationFrame,
  onClick,
}: {
  readonly documentImpl?: Document;
  readonly requestAnimationFrameImpl?: (callback: FrameRequestCallback) => number | void;
  readonly onClick?: () => void;
} = {}): HTMLButtonElement {
  const button = documentImpl.createElement("button");
  button.className = "follow-button";
  button.setAttribute("aria-label", "Scroll to bottom");
  button.innerHTML = icon(ArrowDown, { size: 18 });
  documentImpl.body.appendChild(button);
  requestAnimationFrameImpl(() => {
    button.classList.add("visible");
  });
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

export function setFollowButtonText(button: HTMLButtonElement | null, _pendingCount: number): void {
  if (button) button.innerHTML = icon(ArrowDown, { size: 18 });
}

export function removeFollowButton(
  button: HTMLButtonElement | null,
  { windowImpl = window }: { readonly windowImpl?: Pick<ScrollWindow, "setTimeout"> } = {},
): void {
  if (!button) return;
  button.classList.remove("visible");
  windowImpl.setTimeout?.(() => {
    if (button.parentNode) button.parentNode.removeChild(button);
  }, 200);
}
