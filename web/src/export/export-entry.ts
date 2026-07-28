// Static export snapshot entry point.
//
// Renders a self-contained session snapshot (GitHub Gist) using the SAME
// rendering modules as the live app (web/src/session/*). It deliberately omits
// every live-only concern: no SSE/live-reload, no chat composer, no
// artifacts, no fetch-backed features. Those DOM hosts are not emitted by the
// server when IsLive is false, so the shared UI helpers no-op.
//
// marked and highlight.js are provided as window globals by the inlined vendor
// <script> tags (see internal/ui/export.go); they are marked external in the
// export Vite build, so this bundle reads window.marked / window.hljs.

import type { HLJSApi } from "highlight.js";
import type { marked } from "marked";
import { loadExportSessionData } from "./export-session-data.js";
import { sessionEntryFromUnknown, type SessionEntry } from "../session/data/session-types.js";
import { escapeHtml } from "../session/render/session-format.js";
import { configureSessionMarkdown, safeMarkedParse } from "./export-markdown.js";
import { downloadExportSessionJson } from "./export-session-download.js";
import { mount } from "svelte";
import SessionTreeNodes from "../components/session/SessionTreeNodes.svelte";
import SessionInfoHeader from "../components/session/SessionInfoHeader.svelte";
import SessionContent from "../components/session/SessionContent.svelte";
import ImageModal from "../components/session/ImageModal.svelte";
import { SessionDataModel } from "../session/data/session-data.svelte.js";
import { createSessionNavigator } from "../session/navigation/session-navigation.js";
import * as toggleStateApi from "./export-toggle-state.js";
import * as sidebarApi from "../session/ui/sidebar.js";
import * as searchFiltersApi from "../session/ui/search-filters.js";
import { setupSessionUi } from "../session/ui/session-ui-runner.js";
import { sessionRuntime } from "../session/session-runtime.js";
import { setupKeyboardNav } from "../shared/keyboard-nav.js";
import { copyExportText } from "./export-clipboard.js";

// In a sandboxed iframe (e.g. a srcdoc preview without `allow-same-origin`),
// even *reading* the `localStorage` property throws SecurityError — which would
// abort the whole bootstrap and leave a blank page. A static snapshot has
// nothing meaningful to persist, so fall back to an in-memory shim. Returning a
// shim (never undefined) also keeps the shared modules off their
// `globalThis.localStorage` default, which would throw the same way.
type ExportWindow = Window & {
  readonly marked: typeof marked;
  readonly hljs?: HLJSApi;
  downloadSessionJson?: () => void;
};

interface ExportAppOptions {
  readonly target?: Window;
}

interface ExportStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

type ExportFilterMode = SessionDataModel["filterMode"];

function isExportFilterMode(value: string): value is ExportFilterMode {
  return ["all", "default", "user-only", "no-tools", "labeled-only"].includes(value);
}

function createExportStorage(): ExportStorage {
  const mem = new Map<string, string>();
  return {
    getItem: (key) => mem.get(key) ?? null,
    setItem: (key, value) => {
      mem.set(key, value);
    },
    removeItem: (key) => {
      mem.delete(key);
    },
    clear: () => {
      mem.clear();
    },
  };
}

function hasExportGlobals(target: Window): target is ExportWindow {
  return target.marked !== undefined;
}

export function runExportApp({ target = window }: ExportAppOptions = {}): void {
  if (!hasExportGlobals(target)) return;
  const documentImpl = target.document;
  const marked = target.marked;
  const hljs = target.hljs || null;
  const storage = createExportStorage();

  const dataModel = loadExportSessionData({
    documentImpl,
    windowImpl: target,
    atobImpl: target.atob?.bind(target),
  });
  // Reactive model that drives the Svelte <SessionTreeNodes> sidebar (same
  // component the live app uses). The snapshot renders once — no live updates —
  // so this just computes the tree/active-path derivations a single time.
  const treeModel = new SessionDataModel(dataModel);
  const contentModel = {
    get activePath(): ReadonlyArray<SessionEntry> {
      return treeModel.activePath.flatMap((candidate) => {
        const entry = sessionEntryFromUnknown(candidate);
        return entry ? [entry] : [];
      });
    },
    entries: dataModel.entries,
    renderedTools: dataModel.renderedTools,
  };

  let filterMode: ExportFilterMode = "default";
  let searchQuery = "";

  const escapeSessionHtml = (text: unknown): string => escapeHtml(text, { documentImpl });

  let currentLeafId = dataModel.leafId;
  let currentTargetId = dataModel.urlTargetId || dataModel.leafId;
  let navigatorInstance: ReturnType<typeof createSessionNavigator>;

  // Push view state into the reactive model; <SessionTreeNodes> recomputes.
  const syncTreeRendererState = () => {
    treeModel.filterMode = filterMode;
    treeModel.searchQuery = searchQuery;
    treeModel.currentLeafId = currentLeafId;
    treeModel.currentTargetId = currentTargetId;
  };
  const renderTree = () => {
    syncTreeRendererState();
  };
  const forceTreeRerender = () => {
    syncTreeRendererState();
  };

  target.downloadSessionJson = () =>
    downloadExportSessionJson({
      entries: dataModel.entries,
      header: dataModel.header,
      documentImpl,
      URLImpl: globalThis.URL,
      BlobImpl: globalThis.Blob,
    });

  // hljs is available synchronously (inlined vendor script). <SessionEntry>/
  // <ToolOutput> emit code with `data-highlight-pending`; this colours them in
  // place after each render (the live app uses applyLazyHighlighting instead).
  const highlightPending = (container: ParentNode | null): void => {
    if (!hljs || !container) return;
    container.querySelectorAll("code[data-highlight-pending]").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const lang = el.dataset.lang;
      const text = el.textContent ?? "";
      el.innerHTML =
        lang && hljs.getLanguage(lang)
          ? hljs.highlight(text, { language: lang }).value
          : hljs.highlightAuto(text).value;
      el.removeAttribute("data-highlight-pending");
      el.removeAttribute("data-lang");
    });
  };

  const ui = setupSessionUi({
    documentImpl,
    windowImpl: target,
    storage,
    marked,
    hljs,
    escapeHtml: escapeSessionHtml,
    markdownApi: {
      configureSessionMarkdown: () =>
        configureSessionMarkdown({ marked, hljs, escapeHtml: escapeSessionHtml }),
      safeMarkedParse: (text) => safeMarkedParse(text, { marked }),
    },
    searchFiltersApi,
    sidebarApi,
    toggleStateApi,
    getLeafId: () => dataModel.leafId,
    setSearchQuery: (value) => {
      searchQuery = value;
    },
    setFilterMode: (value) => {
      if (isExportFilterMode(value)) filterMode = value;
    },
    forceTreeRerender,
    navigateTo: (...args) => navigateTo(...args),
  });

  const navigateTo = (
    targetId: string,
    scrollMode: "target" | "bottom" | "none" = "target",
    scrollToEntryId: string | null = null,
  ): void => navigatorInstance.navigateTo(targetId, scrollMode, scrollToEntryId);

  // Nav + scroll only; <SessionContent> (mounted below) renders the message pane
  // reactively from treeModel.activePath, which onNavigate updates.
  navigatorInstance = createSessionNavigator({
    documentImpl,
    renderTree,
    onNavigate: (leaf, targetId) => {
      currentLeafId = leaf;
      currentTargetId = targetId;
      treeModel.currentLeafId = leaf;
      treeModel.currentTargetId = targetId;
    },
  });

  // Mount the reactive message pane into #messages (same component the live app
  // uses). The snapshot renders once; renderEntry/hljs are synchronous here, so
  // entries paint immediately. afterRender re-applies collapse/toggle state.
  const messagesEl = documentImpl.getElementById("messages");
  if (messagesEl) {
    mount(SessionContent, {
      target: messagesEl,
      props: {
        model: contentModel,
        afterRender: (container: HTMLElement) => {
          sessionRuntime.toggleState?.applyToNode(container);
          highlightPending(container);
        },
        copyText: (text: string) =>
          copyExportText(text, { documentImpl, navigatorImpl: target.navigator }),
      },
    });
  }

  // Mount the Svelte tree sidebar into #sidebar (the static #tree-container /
  // #tree-status were removed from share-session.html; the component renders them).
  const sidebarEl = documentImpl.getElementById("sidebar");
  if (sidebarEl) {
    mount(SessionTreeNodes, {
      target: sidebarEl,
      props: {
        model: treeModel,
        onNavigate: (id: string) => {
          const leaf = treeModel.newestLeaf(id) || id;
          navigateTo(leaf, "target", id);
          if (ui.isMobileLayout()) ui.closeSidebar();
        },
      },
    });
  }

  // Mount the Svelte header card into #header-container (rendered once), then
  // bind its toggle buttons exactly once (the controller doesn't guard against
  // double-binding and the header no longer re-renders per navigation).
  const headerEl = documentImpl.getElementById("header-container");
  if (headerEl) {
    mount(SessionInfoHeader, { target: headerEl, props: { model: treeModel } });
  }
  ui.attachHeaderHandlers();

  setupKeyboardNav({ windowImpl: target, documentImpl });
  const imageModalHost = documentImpl.getElementById("image-modal-host");
  if (imageModalHost) mount(ImageModal, { target: imageModalHost });

  // Initial render: deep-link to the target message when the URL carries one,
  // otherwise show the active leaf path from the top.
  const leafId = dataModel.leafId;
  if (leafId) {
    if (dataModel.urlTargetId && dataModel.byId.has(dataModel.urlTargetId)) {
      navigateTo(leafId, "target", dataModel.urlTargetId);
    } else {
      navigateTo(leafId, "none");
    }
  } else {
    const lastEntry = dataModel.entries.at(-1);
    if (lastEntry) navigateTo(lastEntry.id, "none");
  }
}

if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  document.getElementById("session-data")
) {
  runExportApp();
}
