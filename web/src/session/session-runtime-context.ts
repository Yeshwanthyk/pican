// Explicit imperative runtime context for the live session page. This is the
// page-owned counterpart to session-runtime.js (component handle registry):
// SessionPage creates the model/navigator/reconcile hooks once, then live
// components and page helpers read them here instead of reaching through window.

export interface SessionRuntimeContext {
  readonly model?: unknown;
  readonly navigator?: { readonly navigateTo?: NavigateTo };
  readonly navigateTo?: NavigateTo | null;
  readonly reconcileEntries?: (entries: ReadonlyArray<unknown>, options?: unknown) => unknown;
  readonly contentRuntime?: { afterRender: ((container: HTMLElement) => void) | null };
  readonly [key: string]: unknown;
}

export type NavigateTo = (
  targetId: string,
  scrollMode?: "target" | "bottom" | "none",
  scrollToEntryId?: string | null,
) => void;

const emptyRuntime: SessionRuntimeContext = Object.freeze({});
let currentRuntime: SessionRuntimeContext = emptyRuntime;

export function setSessionRuntime(runtime: SessionRuntimeContext = {}): SessionRuntimeContext {
  currentRuntime = {
    ...runtime,
    navigateTo: runtime.navigateTo || runtime.navigator?.navigateTo || null,
  };

  return currentRuntime;
}

export function getSessionRuntime(): SessionRuntimeContext {
  return currentRuntime;
}

export function resetSessionRuntimeContext(): void {
  currentRuntime = emptyRuntime;
}
