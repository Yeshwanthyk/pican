import { marked } from "marked";
import { wireSessionContentRuntime } from "../session-content-runtime.js";
import { setupSessionGlobals } from "../session-globals.js";
import { configureSessionMarkdown, safeMarkedParse } from "../render/markdown.js";
import { setupSessionUi } from "../ui/session-ui-runner.js";
import * as sidebarApi from "../ui/sidebar.js";
import * as searchFiltersApi from "../ui/search-filters.js";
import * as toggleStateApi from "../ui/toggle-state.js";
import { configureSettingsSync, hydrateSettings } from "../../shared/settings-store.js";
import { getSessionRuntime } from "../session-runtime-context.js";
import type { NavigateTo, SessionRuntimeContext } from "../session-runtime-context.js";
import {
  isUnknownRecord,
  type SessionEntry,
  type ToolCallInfo,
  type UnknownRecord,
} from "../data/session-types.js";

declare global {
  interface Window {
    marked?: typeof marked;
  }
}

interface RuntimeModel {
  entries: ReadonlyArray<SessionEntry>;
  header: UnknownRecord | null;
  toolCallMap: ReadonlyMap<string, ToolCallInfo>;
  labelMap: Map<string, string>;
  leafId: string;
  currentLeafId: string;
  urlTargetId?: string | null;
  searchQuery: string;
  filterMode: string;
}

const isRuntimeModel = (value: unknown): value is RuntimeModel => {
  if (!isUnknownRecord(value)) return false;
  return Array.isArray(value.entries) && value.toolCallMap instanceof Map && value.labelMap instanceof Map;
};

export function startSessionPageRuntime({
  sessionId,
  applyLazyHighlighting,
  windowImpl = window,
  documentImpl = document,
  runtime = getSessionRuntime(),
}: {
  readonly sessionId: string;
  readonly applyLazyHighlighting: (documentImpl: Document) => void;
  readonly windowImpl?: Window & typeof globalThis;
  readonly documentImpl?: Document;
  readonly runtime?: SessionRuntimeContext;
}): () => void {
  const model = runtime.model;
  const navigateTo: NavigateTo | null = runtime.navigateTo ?? null;
  if (!isRuntimeModel(model) || navigateTo === null) return () => undefined;

  configureSettingsSync({
    fetchImpl: windowImpl.fetch ? windowImpl.fetch.bind(windowImpl) : undefined,
  });
  // Kick off settings hydration in the background. The toggle controller and
  // SessionContent render before this resolves on a cold cache (no localStorage
  // yet), so they'd otherwise be stuck on toggleStateDefaults; once hydration
  // lands we call toggleController.reload() to pick up the user's configured
  // defaults and re-apply them to the already-rendered DOM.
  const hydrated = hydrateSettings({ storage: windowImpl.localStorage });
  windowImpl.marked = windowImpl.marked || marked;

  const contentWiring = wireSessionContentRuntime({
    windowImpl,
    documentImpl,
    model,
    sessionId,
    contentRuntime: runtime.contentRuntime ?? null,
    applyLazyHighlighting,
  });
  const { sessionFormat } = contentWiring;

  const ui = setupSessionUi({
    documentImpl,
    windowImpl,
    storage: windowImpl.localStorage,
    sessionId,
    marked,
    hljs: null,
    escapeHtml: sessionFormat.escapeHtml,
    markdownApi: { configureSessionMarkdown, safeMarkedParse },
    searchFiltersApi,
    sidebarApi,
    toggleStateApi,
    getLeafId: () => model.leafId,
    setSearchQuery: (value) => {
      model.searchQuery = value;
    },
    setFilterMode: (value) => {
      model.filterMode = value;
    },
    forceTreeRerender: () => {},
    navigateTo,
  });

  ui.attachHeaderHandlers();
  // Catch up the toggle state to whatever the server returned, once it lands.
  // hydrated may be null when fetch isn't configured (export bundle / tests).
  hydrated?.then?.((settings) => {
    if (settings) ui.toggleController.reload();
  });
  navigateTo(
    model.currentLeafId,
    model.urlTargetId ? "target" : "bottom",
    model.urlTargetId || null,
  );

  const disposeGlobals = setupSessionGlobals({ windowImpl, documentImpl });

  return () => {
    disposeGlobals?.();
    contentWiring.dispose?.();
  };
}
