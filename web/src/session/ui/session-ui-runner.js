import { sessionRuntime } from "../session-runtime.js";

export function setupSessionUi({
  documentImpl = document,
  windowImpl = window,
  storage = localStorage,
  sessionId = "",
  marked,
  hljs,
  escapeHtml,
  markdownApi,
  searchFiltersApi,
  sidebarApi,
  toggleStateApi,
  getLeafId,
  setSearchQuery,
  setFilterMode,
  forceTreeRerender,
  navigateTo,
} = {}) {
  markdownApi.configureSessionMarkdown({ marked, hljs, escapeHtml });
  const safeMarkedParse = (text) => markdownApi.safeMarkedParse(text, { marked });

  const searchFilterControls = searchFiltersApi.setupSessionSearchAndFilters({
    documentImpl,
    getLeafId,
    setSearchQuery,
    setFilterMode,
    forceTreeRerender,
    navigateTo,
  });

  // The live app's tree is a FullScreenSheet overlay (see SessionTree.svelte);
  // this hamburger/overlay/close wiring only matters for the static export's
  // simplified docked sidebar, whose only mobile affordance is this drawer.
  // The elements are absent in the live DOM, so this is a no-op there.
  const isMobileLayout = () => sidebarApi.isMobileLayout({ windowImpl });
  const closeSidebar = () => sidebarApi.setSidebarOpen(false, { documentImpl });
  const openSidebar = () => sidebarApi.setSidebarOpen(true, { documentImpl });
  const overlayEl = documentImpl.getElementById("sidebar-overlay");
  overlayEl?.addEventListener("click", closeSidebar);
  overlayEl?.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      closeSidebar();
    },
    { passive: false },
  );
  documentImpl.getElementById("hamburger")?.addEventListener("click", openSidebar);
  documentImpl.getElementById("sidebar-close")?.addEventListener("click", closeSidebar);

  const toggleController = toggleStateApi.createToggleController({
    documentImpl,
    storage,
    sessionId,
  });
  // Registered so the message-pane afterRender hook (live content-runtime +
  // export-entry) can re-apply persisted collapse/toggle state to new nodes.
  sessionRuntime.toggleState = toggleController;

  const attachHeaderHandlers = () => toggleController.attachHeaderHandlers();
  const toggleThinking = () => toggleController.toggleThinking();
  const toggleToolsVisibility = () => toggleController.toggleToolsVisibility();
  const toggleToolOutputs = () => toggleController.toggleToolOutputs();

  searchFiltersApi.setupSessionKeyboardShortcuts({
    documentImpl,
    clearSearch: () => searchFilterControls.clearAndNavigateBottom(),
    toggleThinking,
    toggleToolsVisibility,
    toggleToolOutputs,
  });

  return {
    safeMarkedParse,
    isMobileLayout,
    closeSidebar,
    attachHeaderHandlers,
    toggleController,
    // The right-sidebar chrome (scratchpad/resize/tabs) lives in <RightSidebar>,
    // which registers its controls in sessionRuntime.rightSidebar. Read lazily so
    // the calls resolve against the mounted component.
    toggleRightSidebar: () => sessionRuntime.rightSidebar?.toggle(),
    openRightSidebar: () => sessionRuntime.rightSidebar?.open(),
    collapseRightSidebar: () => sessionRuntime.rightSidebar?.collapse(),
    activateRightTab: (pane) => sessionRuntime.rightSidebar?.activateTab(pane),
  };
}
