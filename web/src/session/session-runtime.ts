// Imperative-handle registry for the live session viewer. Replaces the
// window.__pi* bridges by which child components published their imperative
// control surfaces for other components and plain-JS runtime modules to call.
// Each component assigns its slot on mount and clears it (null) on destroy;
// consumers read `sessionRuntime.<slot>?.method()`. Reads are all imperative
// (event handlers / onMount), so a plain object is enough — no reactivity needed.
//
// There is one session viewer at a time, so a module singleton suffices;
// resetSessionRuntime() clears it when <SessionPage> unmounts so SPA re-entry
// never sees a stale handle. Kept dependency-free so it stays safe to pull into
// the server-less export bundle (via session-ui-runner).
export interface ArtifactRuntime {
  setArtifacts?(
    artifacts: ReadonlyArray<unknown>,
    options?: { readonly hiddenCount?: number },
  ): void;
  selectArtifact?(id: string): void;
  render?(): void;
  getSelectedId?(): string;
  getArtifact?(id: string): unknown;
  getCount?(): number;
}

export interface RightSidebarRuntime {
  toggle?(): void;
  open?(): void;
  collapse?(): void;
  activateTab?(pane: string): void;
}

export interface ToggleStateRuntime {
  applyToNode(node: ParentNode): void;
  reload?(): void;
}

interface SessionRuntimeHandles {
  artifacts: ArtifactRuntime | null;
  rightSidebar: RightSidebarRuntime | null;
  toggleState: ToggleStateRuntime | null;
}

export const sessionRuntime: SessionRuntimeHandles = {
  artifacts: null, // { setArtifacts, selectArtifact, getArtifact, getCount, ... }
  rightSidebar: null, // { toggle, open, collapse, activateTab }
  toggleState: null, // toggle controller { applyToNode, toggleThinking, ... }
};

export function resetSessionRuntime(): void {
  sessionRuntime.artifacts = null;
  sessionRuntime.rightSidebar = null;
  sessionRuntime.toggleState = null;
}
