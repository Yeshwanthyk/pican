// Reactive open-state for the session viewer's modals/sheets. Replaces the
// window.__piOpen* bridge: <SessionPage> binds the modal components to this
// state, and any consumer — Svelte component or plain-JS runtime module
// (session-globals, session-content-runtime) — imports the
// open* helpers directly instead of reaching through window. There is one
// session viewer at a time, so a module singleton is sufficient; resetSessionModals()
// clears it when <SessionPage> unmounts so SPA re-entry never shows a stale modal.
interface ForkEntry {
  readonly id?: string;
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: string | ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  };
}

const hasUserMessage = (entries: ReadonlyArray<ForkEntry>): boolean =>
  entries.some((entry) => {
    if (entry.type !== "message" || entry.message?.role !== "user") return false;
    const content = entry.message.content;
    if (typeof content === "string") return content.trim().length > 0;
    return content?.some((block) => block.type === "text" && Boolean(block.text?.trim())) ?? false;
  });

interface LabelSave {
  readonly entryId: string;
  readonly label: string;
}

interface SessionModalState {
  shortcuts: boolean;
  modelUsage: boolean;
  fork: {
    open: boolean;
    entries: ForkEntry[];
    onSelect: ((entryId: string) => void) | null;
  };
  label: {
    open: boolean;
    entryId: string;
    currentLabel: string;
    onSave: ((value: LabelSave) => void | Promise<void>) | null;
  };
  diff: { open: boolean; sessionId: string };
  tree: { open: boolean };
}

interface HistoryWindow {
  readonly location: { readonly href: string };
  readonly history: {
    readonly state: unknown;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
}

export const sessionModals = $state<SessionModalState>({
  shortcuts: false,
  modelUsage: false,
  fork: { open: false, entries: [], onSelect: null },
  label: { open: false, entryId: "", currentLabel: "", onSave: null },
  diff: { open: false, sessionId: "" },
  tree: { open: false },
});

export function openShortcuts(): void {
  sessionModals.shortcuts = true;
}

export function openModelUsage(): void {
  sessionModals.modelUsage = true;
}

// Returns false (and does not open) when there are no user messages to fork
// from, so the command menu can surface a toast.
export function openFork({
  entries = [],
  onSelect = null,
}: {
  readonly entries?: ForkEntry[];
  readonly onSelect?: ((entryId: string) => void) | null;
} = {}): boolean {
  if (!hasUserMessage(entries)) return false;
  sessionModals.fork.entries = entries;
  sessionModals.fork.onSelect = onSelect;
  sessionModals.fork.open = true;
  return true;
}

export function openLabel({
  entryId = "",
  currentLabel = "",
  onSave = null,
}: {
  readonly entryId?: string;
  readonly currentLabel?: string;
  readonly onSave?: ((value: LabelSave) => void | Promise<void>) | null;
} = {}): void {
  sessionModals.label.entryId = entryId;
  sessionModals.label.currentLabel = currentLabel;
  sessionModals.label.onSave = onSave;
  sessionModals.label.open = true;
}

export function openDiff({ sessionId = "" }: { readonly sessionId?: string } = {}): void {
  sessionModals.diff.sessionId = sessionId;
  sessionModals.diff.open = true;
}

export function openTree(): void {
  sessionModals.tree.open = true;
}

export function closeTree(): void {
  sessionModals.tree.open = false;
}

export function toggleTree(): void {
  sessionModals.tree.open = !sessionModals.tree.open;
}

// The diff modal's open state is mirrored to a `?diff=open` query param so a
// page refresh restores the open sheet. SessionShell drives this — calling
// syncDiffUrlParam whenever sessionModals.diff.open flips, and restoring from
// the URL on mount before the sync effect runs (otherwise the effect would
// strip the param before we could read it).
export const DIFF_URL_PARAM = "diff";
export const DIFF_URL_VALUE = "open";

export function syncDiffUrlParam(
  open: boolean,
  { windowImpl }: { readonly windowImpl?: HistoryWindow } = {},
): void {
  const win = windowImpl ?? (typeof window !== "undefined" ? window : undefined);
  if (!win) return;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- one-shot read+mutate, fed to replaceState; not reactive state
  const url = new URL(win.location.href);
  const has = url.searchParams.get(DIFF_URL_PARAM) === DIFF_URL_VALUE;
  if (open === has) return;
  if (open) url.searchParams.set(DIFF_URL_PARAM, DIFF_URL_VALUE);
  else url.searchParams.delete(DIFF_URL_PARAM);
  // replaceState (not push) so back-button behavior is unchanged — closing the
  // modal must not require a second back press.
  win.history.replaceState(win.history.state, "", url);
}

export function hasDiffUrlParam({
  windowImpl,
}: { readonly windowImpl?: HistoryWindow } = {}): boolean {
  const win = windowImpl ?? (typeof window !== "undefined" ? window : undefined);
  if (!win) return false;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- one-shot read of location, not reactive state
  return new URL(win.location.href).searchParams.get(DIFF_URL_PARAM) === DIFF_URL_VALUE;
}

// The session tree overlay mirrors its open state to `?tree=open`, exactly
// like the diff sheet above — SessionShell drives syncTreeUrlParam/restore the
// same way.
export const TREE_URL_PARAM = "tree";
export const TREE_URL_VALUE = "open";

export function syncTreeUrlParam(
  open: boolean,
  { windowImpl }: { readonly windowImpl?: HistoryWindow } = {},
): void {
  const win = windowImpl ?? (typeof window !== "undefined" ? window : undefined);
  if (!win) return;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- one-shot read+mutate, fed to replaceState; not reactive state
  const url = new URL(win.location.href);
  const has = url.searchParams.get(TREE_URL_PARAM) === TREE_URL_VALUE;
  if (open === has) return;
  if (open) url.searchParams.set(TREE_URL_PARAM, TREE_URL_VALUE);
  else url.searchParams.delete(TREE_URL_PARAM);
  win.history.replaceState(win.history.state, "", url);
}

export function hasTreeUrlParam({
  windowImpl,
}: { readonly windowImpl?: HistoryWindow } = {}): boolean {
  const win = windowImpl ?? (typeof window !== "undefined" ? window : undefined);
  if (!win) return false;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- one-shot read of location, not reactive state
  return new URL(win.location.href).searchParams.get(TREE_URL_PARAM) === TREE_URL_VALUE;
}

export function resetSessionModals(): void {
  sessionModals.shortcuts = false;
  sessionModals.modelUsage = false;
  sessionModals.fork.open = false;
  sessionModals.fork.entries = [];
  sessionModals.fork.onSelect = null;
  sessionModals.label.open = false;
  sessionModals.label.entryId = "";
  sessionModals.label.currentLabel = "";
  sessionModals.label.onSave = null;
  sessionModals.diff.open = false;
  sessionModals.diff.sessionId = "";
  sessionModals.tree.open = false;
}
