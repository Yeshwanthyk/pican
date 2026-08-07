import { sessionRuntime } from "../session-runtime.js";
import type { NavigateTo } from "../session-runtime-context.js";
import type { ToggleState } from "./toggle-state.js";

interface UiStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface UiWindow {
  matchMedia?(query: string): { readonly matches: boolean };
}

interface ToggleController {
  readonly state: ToggleState;
  applyToNode(node: ParentNode): void;
  syncButtons(): void;
  toggleThinking(): void;
  toggleToolsVisibility(): void;
  toggleToolOutputs(): void;
  reload(): void;
  attachHeaderHandlers(): void;
}

interface SetupSessionUiOptions {
  readonly documentImpl?: Document;
  readonly windowImpl?: UiWindow;
  readonly storage?: UiStorage;
  readonly sessionId?: string;
  readonly marked: unknown;
  readonly hljs: unknown;
  readonly escapeHtml: (text: string) => string;
  readonly markdownApi: {
    configureSessionMarkdown(options: {
      readonly marked: unknown;
      readonly hljs: unknown;
      readonly escapeHtml: (text: string) => string;
    }): void;
    safeMarkedParse(text: string, options: { readonly marked: unknown }): string;
  };
  readonly searchFiltersApi: {
    setupSessionSearchAndFilters(options: {
      readonly documentImpl: Document;
      readonly getLeafId: () => string;
      readonly setSearchQuery: (value: string) => void;
      readonly setFilterMode: (value: string) => void;
      readonly forceTreeRerender: () => void;
      readonly navigateTo: NavigateTo;
    }): { clearAndNavigateBottom(): void; dispose(): void };
    setupSessionKeyboardShortcuts(options: {
      readonly documentImpl: Document;
      readonly clearSearch: () => void;
      readonly toggleThinking: () => void;
      readonly toggleToolsVisibility: () => void;
      readonly toggleToolOutputs: () => void;
    }): () => void;
  };
  readonly sidebarApi: {
    isMobileLayout(options: { readonly windowImpl: UiWindow }): boolean;
    setSidebarOpen(open: boolean, options: { readonly documentImpl: Document }): void;
  };
  readonly toggleStateApi: {
    createToggleController(options: {
      readonly documentImpl: Document;
      readonly storage: UiStorage;
      readonly sessionId: string;
    }): ToggleController;
  };
  readonly getLeafId: () => string;
  readonly setSearchQuery: (value: string) => void;
  readonly setFilterMode: (value: string) => void;
  readonly forceTreeRerender: () => void;
  readonly navigateTo: NavigateTo;
}

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
}: SetupSessionUiOptions) {
  markdownApi.configureSessionMarkdown({ marked, hljs, escapeHtml });
  const safeMarkedParse = (text: string) => markdownApi.safeMarkedParse(text, { marked });

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
  const onOverlayTouch = (event: TouchEvent) => {
    event.preventDefault();
    closeSidebar();
  };
  const hamburger = documentImpl.getElementById("hamburger");
  const sidebarClose = documentImpl.getElementById("sidebar-close");
  overlayEl?.addEventListener("click", closeSidebar);
  overlayEl?.addEventListener("touchstart", onOverlayTouch, { passive: false });
  hamburger?.addEventListener("click", openSidebar);
  sidebarClose?.addEventListener("click", closeSidebar);

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

  const disposeKeyboardShortcuts = searchFiltersApi.setupSessionKeyboardShortcuts({
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
    toggleRightSidebar: () => sessionRuntime.rightSidebar?.toggle?.(),
    openRightSidebar: () => sessionRuntime.rightSidebar?.open?.(),
    collapseRightSidebar: () => sessionRuntime.rightSidebar?.collapse?.(),
    activateRightTab: (pane: string) => sessionRuntime.rightSidebar?.activateTab?.(pane),
    dispose: () => {
      disposeKeyboardShortcuts();
      searchFilterControls.dispose();
      overlayEl?.removeEventListener("click", closeSidebar);
      overlayEl?.removeEventListener("touchstart", onOverlayTouch);
      hamburger?.removeEventListener("click", openSidebar);
      sidebarClose?.removeEventListener("click", closeSidebar);
    },
  };
}
