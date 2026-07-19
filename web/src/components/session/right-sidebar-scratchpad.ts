import { Schema } from "effect";
import * as Http from "../../lib/http";
import type { FetchLike } from "../../lib/http";
import { runPromise } from "../../lib/runtime";

const ScratchpadResponse = Schema.Struct({ content: Schema.optionalKey(Schema.String) });
const SaveResponse = Schema.Struct({ ok: Schema.optionalKey(Schema.Boolean) });

interface ScratchpadOptions {
  readonly projectPath?: string;
  readonly textarea?: HTMLTextAreaElement | null;
  readonly statusEl?: HTMLElement | null;
  readonly fetchImpl?: FetchLike;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
  readonly saveDelayMs?: number;
}

export function createScratchpadController({
  projectPath = "",
  textarea,
  statusEl,
  fetchImpl = fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  saveDelayMs = 1000,
}: ScratchpadOptions = {}) {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = textarea ? textarea.value : "";

  function setStatus(text: string, cls = ""): void {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `scratchpad-status ${cls || ""}`.trim();
  }

  function load(): Promise<void> {
    if (!projectPath || !textarea) return Promise.resolve();
    return runPromise(
      Http.get(`/api/scratchpad?project=${encodeURIComponent(projectPath)}`, ScratchpadResponse, {
        fetchImpl,
      }),
    ).then(
      (data) => {
        const content = data.content ?? "";
        textarea.value = content;
        lastSaved = content;
        setStatus("Saved", "saved");
      },
      () => setStatus("Load failed"),
    );
  }

  function save(): Promise<void> {
    if (!projectPath || !textarea) return Promise.resolve();
    const content = textarea.value;
    if (content === lastSaved) return Promise.resolve();
    setStatus("Saving…", "saving");
    return runPromise(
      Http.post("/api/scratchpad", { project: projectPath, content }, SaveResponse, { fetchImpl }),
    ).then(
      () => {
        lastSaved = content;
        setStatus("Saved", "saved");
      },
      () => setStatus("Save failed"),
    );
  }

  function onInput(): void {
    setStatus("Saving…", "saving");
    clearTimeoutImpl(saveTimer);
    saveTimer = setTimeoutImpl(() => void save(), saveDelayMs);
  }

  function adoptCurrentValue(): void {
    if (textarea) lastSaved = textarea.value;
  }

  function bind(): () => void {
    textarea?.addEventListener("input", onInput);
    return () => {
      textarea?.removeEventListener("input", onInput);
      clearTimeoutImpl(saveTimer);
    };
  }

  return {
    load,
    save,
    setStatus,
    adoptCurrentValue,
    bind,
  };
}
