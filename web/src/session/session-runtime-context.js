// Explicit imperative runtime context for the live session page. This is the
// page-owned counterpart to session-runtime.js (component handle registry):
// SessionPage creates the model/navigator/reconcile hooks once, then live
// components and page helpers read them here instead of reaching through window.

const emptyRuntime = Object.freeze({});
let currentRuntime = emptyRuntime;

export function setSessionRuntime(runtime = {}) {
  currentRuntime = {
    ...runtime,
    navigateTo: runtime.navigateTo || runtime.navigator?.navigateTo || null,
  };

  return currentRuntime;
}

export function getSessionRuntime() {
  return currentRuntime;
}

export function resetSessionRuntimeContext() {
  currentRuntime = emptyRuntime;
}
