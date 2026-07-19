// Width at/below which the session UI switches to the mobile layout (drawer
// sidebars instead of inline panels). Shared so the media query lives in one
// place; see isMobileLayout.
export const MOBILE_BREAKPOINT_PX = 900;
export const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

export function isMobileLayout({ windowImpl = window } = {}) {
  if (!windowImpl || typeof windowImpl.matchMedia !== "function") {
    return false;
  }
  return windowImpl.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

// Static export's mobile tree drawer (hamburger/overlay/close button). The
// live app's tree is a FullScreenSheet overlay (see SessionTree.svelte) and
// does not use this — this remains only for export's simplified docked
// sidebar, whose only mobile affordance is the hamburger drawer.
export function setSidebarOpen(open, { documentImpl = document } = {}) {
  const sidebar = documentImpl.getElementById("sidebar");
  const overlay = documentImpl.getElementById("sidebar-overlay");
  const hamburger = documentImpl.getElementById("hamburger");
  sidebar?.classList.toggle("open", open);
  overlay?.classList.toggle("open", open);
  documentImpl.body?.classList.toggle("sidebar-open", open);
  if (hamburger) hamburger.style.display = open ? "none" : "";
}
