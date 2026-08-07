export interface SessionSwitchUiState {
  readonly composerText: string;
  readonly transcriptScrollTop: number;
  readonly following: boolean;
}

export type SessionSwitchUiStatePatch = Partial<SessionSwitchUiState>;

export const DEFAULT_SESSION_SWITCH_UI_STATE: SessionSwitchUiState = Object.freeze({
  composerText: "",
  transcriptScrollTop: 0,
  following: true,
});

const cloneState = (state: SessionSwitchUiState): SessionSwitchUiState => ({ ...state });

/**
 * App-lifetime-only LRU for ephemeral session UI state. It deliberately stores
 * no session data, workers, models, components, or DOM references.
 */
export class SessionSwitchStateCache {
  readonly #capacity: number;
  readonly #entries = new Map<string, SessionSwitchUiState>();

  constructor(capacity = 16) {
    this.#capacity = Number.isInteger(capacity) && capacity > 0 ? capacity : 16;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(sessionId: string): SessionSwitchUiState | undefined {
    const state = this.#entries.get(sessionId);
    if (!state) return undefined;
    this.#entries.delete(sessionId);
    this.#entries.set(sessionId, state);
    return cloneState(state);
  }

  update(sessionId: string, patch: SessionSwitchUiStatePatch): void {
    if (!sessionId) return;
    const current = this.#entries.get(sessionId) ?? DEFAULT_SESSION_SWITCH_UI_STATE;
    const next: SessionSwitchUiState = {
      composerText: patch.composerText ?? current.composerText,
      transcriptScrollTop: patch.transcriptScrollTop ?? current.transcriptScrollTop,
      following: patch.following ?? current.following,
    };
    this.#entries.delete(sessionId);
    this.#entries.set(sessionId, next);

    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}
