// Client-side SPA navigation. App.svelte (the root router) wraps
// history.pushState to emit a 'pican:locationchange' event and swaps the active
// page whenever window.location.pathname changes, so pushing a URL here
// navigates between SPA routes (e.g. the sessions index → a session view)
// without a full page reload.

export interface NavigationWindow {
  readonly history: { pushState(data: unknown, unused: string, url?: string | URL | null): void };
}

interface NavigationOptions {
  readonly windowImpl?: NavigationWindow;
}

interface NavigationEvent {
  readonly defaultPrevented?: boolean;
  readonly button?: number;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  preventDefault(): void;
}

function resolveWindow(windowImpl?: NavigationWindow): NavigationWindow | undefined {
  if (windowImpl) return windowImpl;
  return typeof window !== "undefined" ? window : undefined;
}

export function navigate(url: string | null | undefined, { windowImpl }: NavigationOptions = {}) {
  const win = resolveWindow(windowImpl);
  if (!url || !win) return;
  win.history.pushState({}, "", url);
}

// Click handler for <a> elements that point at an internal SPA route. Defers to
// the browser's default navigation for modified clicks (open in new tab/window),
// non-primary mouse buttons, and already-handled events, so the usual link
// affordances keep working; otherwise it intercepts and navigates client-side.
export function handleNavClick(
  event: NavigationEvent | null | undefined,
  url: string | null | undefined,
  { windowImpl }: NavigationOptions = {},
) {
  if (!url || !event) return;
  if (event.defaultPrevented) return;
  if (typeof event.button === "number" && event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(url, { windowImpl });
}
