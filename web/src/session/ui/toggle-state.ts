import { Effect, Schema } from "effect";
import { runSync } from "../../lib/runtime";
import { getJson, setJson } from "../../lib/storage";

export const TOGGLE_STATE_STORAGE_KEY = "pican:session-detail:toggle-state";
export const TOGGLE_DEFAULT_SETTING_KEYS = {
  thinkingExpanded: "pican:v1:toggle:thinking",
  toolsVisible: "pican:v1:toggle:tools",
  toolOutputsExpanded: "pican:v1:toggle:tool-outputs",
};
const ToggleStateSchema = Schema.Struct({
  thinkingExpanded: Schema.Boolean,
  toolsVisible: Schema.Boolean,
  toolOutputsExpanded: Schema.Boolean,
});
type DecodedToggleState = typeof ToggleStateSchema.Type;
export type ToggleState = { -readonly [Key in keyof DecodedToggleState]: DecodedToggleState[Key] };

interface ToggleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type ToggleKey = keyof ToggleState;
type SessionToggleMap = Record<string, Partial<ToggleState>>;
const SessionToggleMapSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    thinkingExpanded: Schema.optionalKey(Schema.Boolean),
    toolsVisible: Schema.optionalKey(Schema.Boolean),
    toolOutputsExpanded: Schema.optionalKey(Schema.Boolean),
  }),
);
const TOGGLE_KEYS: ReadonlyArray<ToggleKey> = [
  "thinkingExpanded",
  "toolsVisible",
  "toolOutputsExpanded",
];

const loadStored = <A>(
  key: string,
  schema: Schema.ConstraintDecoder<A, never>,
  fallback: A,
  storage: ToggleStorage | null | undefined,
): A =>
  runSync(
    getJson(key, schema, storage ?? undefined).pipe(
      Effect.map((value) => value ?? fallback),
      Effect.catch(() => Effect.succeed(fallback)),
    ),
  );

const saveStored = (key: string, value: unknown, storage: ToggleStorage | undefined): void => {
  runSync(setJson(key, value, Schema.Unknown, storage).pipe(Effect.catch(() => Effect.void)));
};

export const toggleStateDefaults: Readonly<ToggleState> = {
  thinkingExpanded: true,
  toolsVisible: true,
  toolOutputsExpanded: false,
};

function readBoolSetting(
  storage: ToggleStorage | null | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const raw = loadStored(key, Schema.Boolean, fallback, storage);
  if (raw === true) return true;
  if (raw === false) return false;
  return fallback;
}

// Read the persisted per-session map. Older builds stored a single flat state
// object at this key (one shared override for every session); that shape is
// discarded here so the configured Session Display defaults apply going
// forward instead of being shadowed by a stale global toggle.
function readSessionMap(storage: ToggleStorage | null | undefined): SessionToggleMap {
  return loadStored(TOGGLE_STATE_STORAGE_KEY, SessionToggleMapSchema, {}, storage);
}

// loadToggleState builds the initial header-toggle state in three layers:
// 1. Hardcoded defaults (toggleStateDefaults).
// 2. Server-backed per-user defaults (TOGGLE_DEFAULT_SETTING_KEYS), already
//    mirrored into localStorage by the settings hydration on page load.
// 3. The per-session override for `sessionId`, if any — set when the user
//    toggled a header button in that specific session, so the next time they
//    open the SAME session it remembers their last choice. Other sessions are
//    not affected, so changing a default in /settings takes effect everywhere
//    the user hasn't explicitly overridden it.
export function loadToggleState({
  sessionId = "",
  storage = globalThis.localStorage,
}: { readonly sessionId?: string; readonly storage?: ToggleStorage } = {}): ToggleState {
  const state: ToggleState = { ...toggleStateDefaults };
  for (const stateKey of TOGGLE_KEYS) {
    const settingKey = TOGGLE_DEFAULT_SETTING_KEYS[stateKey];
    state[stateKey] = readBoolSetting(storage, settingKey, state[stateKey]);
  }
  if (!sessionId) return state;
  const saved = readSessionMap(storage)[sessionId];
  if (saved && typeof saved === "object") {
    if (typeof saved.thinkingExpanded === "boolean")
      state.thinkingExpanded = saved.thinkingExpanded;
    if (typeof saved.toolsVisible === "boolean") state.toolsVisible = saved.toolsVisible;
    if (typeof saved.toolOutputsExpanded === "boolean")
      state.toolOutputsExpanded = saved.toolOutputsExpanded;
  }
  return state;
}

export function saveToggleState(
  state: ToggleState,
  {
    sessionId = "",
    storage = globalThis.localStorage,
  }: {
    readonly sessionId?: string;
    readonly storage?: ToggleStorage;
  } = {},
): void {
  if (!sessionId) return;
  const map = readSessionMap(storage);
  map[sessionId] = {
    thinkingExpanded: state.thinkingExpanded,
    toolsVisible: state.toolsVisible,
    toolOutputsExpanded: state.toolOutputsExpanded,
  };
  saveStored(TOGGLE_STATE_STORAGE_KEY, map, storage);
}

export function applyToggleStateToNode(
  node: ParentNode | null | undefined,
  state: ToggleState,
): void {
  if (!node) return;
  node.querySelectorAll<HTMLElement>(".thinking-text").forEach((el) => {
    el.style.display = state.thinkingExpanded ? "" : "none";
  });
  node.querySelectorAll<HTMLElement>(".thinking-collapsed").forEach((el) => {
    el.style.display = state.thinkingExpanded ? "none" : "block";
  });
  node.querySelectorAll<HTMLElement>(".tool-execution, .compaction").forEach((el) => {
    el.style.display = state.toolsVisible ? "" : "none";
  });
  // Mirrors the .thinking-text / .thinking-collapsed pair: show a "Tool: <name>
  // ..." placeholder so a hidden tool call still has a visible marker (and an
  // assistant message whose only content is a tool call isn't a stranded
  // timestamp). The placeholder lives next to each .tool-execution in
  // ToolCall.svelte.
  node.querySelectorAll<HTMLElement>(".tool-call-collapsed").forEach((el) => {
    el.style.display = state.toolsVisible ? "none" : "block";
  });
  node.querySelectorAll(".tool-output.expandable").forEach((el) => {
    el.classList.toggle("expanded", state.toolOutputsExpanded);
  });
  node.querySelectorAll(".compaction").forEach((el) => {
    el.classList.toggle("expanded", state.toolOutputsExpanded);
  });
}

export function syncToggleButtons(documentImpl: Document, state: ToggleState): void {
  const buttons: ReadonlyArray<readonly [HTMLButtonElement | null, boolean]> = [
    [
      documentImpl.querySelector<HTMLButtonElement>('[data-action="toggle-thinking"]'),
      state.thinkingExpanded,
    ],
    [
      documentImpl.querySelector<HTMLButtonElement>('[data-action="toggle-tools"]'),
      state.toolsVisible,
    ],
    [
      documentImpl.querySelector<HTMLButtonElement>('[data-action="toggle-tool-output"]'),
      state.toolOutputsExpanded,
    ],
  ];
  buttons.forEach(([btn, isActive]) => {
    if (!btn) return;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  // The tool-output toggle has no visible effect while tool calls are hidden,
  // since the output blocks live inside the .tool-execution wrapper that's
  // already display:none. Disable it (and its keyboard shortcut, see
  // createToggleController.toggleToolOutputs) so the control doesn't claim to
  // do something it can't until tools are turned back on.
  const toolOutputBtn = documentImpl.querySelector<HTMLButtonElement>(
    '[data-action="toggle-tool-output"]',
  );
  if (toolOutputBtn) {
    toolOutputBtn.disabled = !state.toolsVisible;
  }
}

export function createToggleController({
  documentImpl = document,
  storage = globalThis.localStorage,
  sessionId = "",
  initialState = loadToggleState({ sessionId, storage }),
}: {
  readonly documentImpl?: Document;
  readonly storage?: ToggleStorage;
  readonly sessionId?: string;
  readonly initialState?: ToggleState;
} = {}) {
  const state = initialState;
  const applyToNode = (node: ParentNode) => applyToggleStateToNode(node, state);
  const syncButtons = () => syncToggleButtons(documentImpl, state);
  const save = () => saveToggleState(state, { sessionId, storage });
  const toggle = (key: ToggleKey) => {
    state[key] = !state[key];
    save();
    applyToNode(documentImpl);
    syncButtons();
  };

  return {
    state,
    get thinkingExpanded() {
      return state.thinkingExpanded;
    },
    get toolsVisible() {
      return state.toolsVisible;
    },
    get toolOutputsExpanded() {
      return state.toolOutputsExpanded;
    },
    applyToNode,
    syncButtons,
    toggleThinking: () => toggle("thinkingExpanded"),
    toggleToolsVisibility: () => toggle("toolsVisible"),
    toggleToolOutputs: () => {
      // Hidden tool calls have no visible output to expand or collapse — no-op
      // so the P shortcut and a disabled button click both stay quiet.
      if (!state.toolsVisible) return;
      toggle("toolOutputsExpanded");
    },
    // Re-read storage and re-apply. Used by the session runtime once
    // hydrateSettings() resolves so a cold-cache first paint (no server-backed
    // toggle keys in localStorage yet) catches up to the user's configured
    // defaults instead of being stuck on toggleStateDefaults.
    reload() {
      const next = loadToggleState({ sessionId, storage });
      state.thinkingExpanded = next.thinkingExpanded;
      state.toolsVisible = next.toolsVisible;
      state.toolOutputsExpanded = next.toolOutputsExpanded;
      applyToNode(documentImpl);
      syncButtons();
    },
    attachHeaderHandlers() {
      documentImpl
        .querySelector('[data-action="toggle-thinking"]')
        ?.addEventListener("click", this.toggleThinking);
      documentImpl
        .querySelector('[data-action="toggle-tools"]')
        ?.addEventListener("click", this.toggleToolsVisibility);
      documentImpl
        .querySelector('[data-action="toggle-tool-output"]')
        ?.addEventListener("click", this.toggleToolOutputs);
      syncButtons();
    },
  };
}
