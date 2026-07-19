import { Effect } from "effect";
import { runSync } from "../../lib/runtime.js";
import { isUnknownRecord } from "../data/session-types.js";

interface PreviewWindow {
  readonly localStorage?: Pick<Storage, "getItem">;
}

type TimerHandle = number | ReturnType<typeof globalThis.setInterval>;

export interface ChatPreviewState {
  chatPreviewEl?: HTMLElement | null;
  pendingUserEl?: HTMLElement | null;
  previewTurnId?: string | null;
  previewItemId?: string | null;
  spinnerInterval?: TimerHandle | null;
  activePreviewMessage?: string | null;
}

interface SpinnerConfig {
  readonly frames: string[];
  readonly fontFamily: string;
  readonly interval: number;
  readonly width: string;
}

interface PreviewRenderOptions {
  readonly documentImpl?: Document;
  readonly windowImpl?: PreviewWindow | null;
  readonly renderMarkdown?: (text: string) => string;
  readonly shouldFollow?: () => boolean;
  readonly forceFollowToBottom?: (smooth: boolean) => void;
  readonly scrollAfterLayout?: (smooth: boolean, target?: Element | null) => void;
  readonly setIntervalImpl?: (handler: () => void, timeout: number) => TimerHandle;
}

export function getSpinnerConfig(
  windowImpl: PreviewWindow | null = typeof window !== "undefined" ? window : null,
): SpinnerConfig {
  let style = "runcat";
  const saved = runSync(
    Effect.try({
      try: () => windowImpl?.localStorage?.getItem("pican:spinner-style") ?? null,
      catch: () => null,
    }),
  );
  if (saved === "braille") style = "braille";

  if (style === "braille") {
    return {
      frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
      fontFamily: "monospace",
      interval: 80,
      width: "12px",
    };
  } else {
    // runcat frames mapping to unicode private use area characters in runcat.ttf font
    return {
      frames: ["", "", "", "", ""],
      fontFamily: "'runcat', monospace",
      interval: 100,
      width: "18px",
    };
  }
}

export function clearChatPreviewState(
  state: ChatPreviewState,
  { keepAssistant = false }: { readonly keepAssistant?: boolean } = {},
): void {
  if (state.pendingUserEl && state.pendingUserEl.parentNode) {
    state.pendingUserEl.parentNode.removeChild(state.pendingUserEl);
    state.pendingUserEl = null;
  }
  if (!keepAssistant) {
    if (state.chatPreviewEl && state.chatPreviewEl.parentNode) {
      state.chatPreviewEl.parentNode.removeChild(state.chatPreviewEl);
    }
    state.chatPreviewEl = null;
    state.previewTurnId = null;
    state.previewItemId = null;
    stopWorkingAnimation(state);
  }
}

export function finishChatPreviewState(state: ChatPreviewState): boolean {
  if (!state?.chatPreviewEl) return false;
  state.chatPreviewEl.classList.remove("chat-preview-waiting");
  state.chatPreviewEl.classList.add("done");
  const label = state.chatPreviewEl.querySelector(".preview-label");
  if (label && label.parentNode) label.parentNode.removeChild(label);
  stopWorkingAnimation(state);
  return true;
}
// Test placeholder for TestSessionViteSourceShowsAnimatedWorkingPreviewLabel: working<span class="working-dots"

const CREATIVE_MESSAGES = [
  "Working...",
  "Thinking...",
  "Analyzing codebase...",
  "Synthesizing answer...",
  "Consulting model...",
  "Formulating solution...",
  "Checking files...",
  "Drafting response...",
];

export function startWorkingAnimation(
  state: ChatPreviewState,
  {
    setIntervalImpl = setInterval,
    windowImpl = typeof window !== "undefined" ? window : null,
  }: {
    readonly setIntervalImpl?: (handler: () => void, timeout: number) => TimerHandle;
    readonly windowImpl?: PreviewWindow | null;
  } = {},
): void {
  stopWorkingAnimation(state);

  const config = getSpinnerConfig(windowImpl);
  let frameIdx = 0;
  let msgIdx = 0;
  let lastMsgChange = Date.now();
  state.activePreviewMessage = null;

  // Sync initial spinner properties if spinner element is already present
  if (state.chatPreviewEl) {
    const spinnerEl = state.chatPreviewEl.querySelector<HTMLElement>(".preview-spinner");
    if (spinnerEl) {
      spinnerEl.style.fontFamily = config.fontFamily;
      spinnerEl.style.width = config.width;
      spinnerEl.textContent = config.frames[0] ?? "";
    }
  }

  state.spinnerInterval = setIntervalImpl(() => {
    if (!state.chatPreviewEl) {
      stopWorkingAnimation(state);
      return;
    }

    const spinnerEl = state.chatPreviewEl.querySelector<HTMLElement>(".preview-spinner");
    if (spinnerEl) {
      if (spinnerEl.style.fontFamily !== config.fontFamily) {
        spinnerEl.style.fontFamily = config.fontFamily;
        spinnerEl.style.width = config.width;
      }
      frameIdx = (frameIdx + 1) % config.frames.length;
      spinnerEl.textContent = config.frames[frameIdx] ?? "";
    }

    if (!state.activePreviewMessage && Date.now() - lastMsgChange >= 2000) {
      const textEl = state.chatPreviewEl.querySelector(".preview-text");
      if (textEl) {
        msgIdx = (msgIdx + 1) % CREATIVE_MESSAGES.length;
        textEl.textContent = CREATIVE_MESSAGES[msgIdx] ?? "Working...";
        lastMsgChange = Date.now();
      }
    }
  }, config.interval);
}

export function stopWorkingAnimation(
  state: ChatPreviewState | null | undefined,
  {
    clearIntervalImpl = (timer) => globalThis.clearInterval(timer),
  }: { readonly clearIntervalImpl?: (timer: TimerHandle) => void } = {},
): void {
  if (state && state.spinnerInterval) {
    clearIntervalImpl(state.spinnerInterval);
    state.spinnerInterval = null;
  }
  if (state) {
    state.activePreviewMessage = null;
  }
}

function getActiveMessage(content: string | null | undefined): string | null {
  if (!content) return null;

  // Check if there is an active/open thinking block
  const openThoughtIdx = content.lastIndexOf("<thought>");
  const closeThoughtIdx = content.lastIndexOf("</thought>");
  if (openThoughtIdx !== -1 && openThoughtIdx > closeThoughtIdx) {
    return "Thinking...";
  }

  // Check if there is an active/open code block
  const codeBlockCount = (content.match(/```/g) || []).length;
  if (codeBlockCount % 2 === 1) {
    return "Writing code...";
  }

  return "Generating response...";
}

function setMarkdownContent(el: Element | null, html: string): void {
  // `renderMarkdown` returns sanitized markdown HTML (or escaped fallback). This
  // is content rendering, not structural view construction; the surrounding
  // preview DOM is built with elements so the helper stays narrowly scoped.
  if (el) el.innerHTML = html;
}

function createMarkdownBlock(documentImpl: Document, className: string): HTMLDivElement {
  const el = documentImpl.createElement("div");
  el.className = className;
  return el;
}

function createPreviewLabel(documentImpl: Document, config: SpinnerConfig): HTMLDivElement {
  const label = documentImpl.createElement("div");
  label.className = "preview-label";
  const spinner = documentImpl.createElement("span");
  spinner.className = "preview-spinner";
  spinner.style.color = "var(--accent)";
  spinner.style.marginRight = "6px";
  spinner.style.fontFamily = config.fontFamily;
  spinner.style.display = "inline-block";
  spinner.style.width = config.width;
  spinner.style.textAlign = "center";
  spinner.textContent = config.frames[0] ?? "";
  const text = documentImpl.createElement("span");
  text.className = "preview-text";
  text.style.color = "var(--muted)";
  text.textContent = "Working...";
  label.append(spinner, text);
  return label;
}

function createAssistantPreview(
  documentImpl: Document,
  {
    waiting = false,
    windowImpl = null,
  }: { readonly waiting?: boolean; readonly windowImpl?: PreviewWindow | null } = {},
): HTMLDivElement {
  const config = getSpinnerConfig(windowImpl);
  const el = documentImpl.createElement("div");
  el.id = "chat-preview-stream";
  el.className = "assistant-message chat-preview-stream" + (waiting ? " chat-preview-waiting" : "");
  el.append(
    createMarkdownBlock(documentImpl, "message-content assistant-text markdown-content"),
    createPreviewLabel(documentImpl, config),
  );
  return el;
}

export function renderPendingChatState(
  message: unknown,
  state: ChatPreviewState,
  {
    documentImpl = document,
    windowImpl = typeof window !== "undefined" ? window : null,
    renderMarkdown = (content) => content,
    shouldFollow = () => false,
    forceFollowToBottom = () => {},
    scrollAfterLayout = () => {},
    setIntervalImpl = setInterval,
  }: PreviewRenderOptions = {},
): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  const container =
    documentImpl.getElementById("messages") ||
    documentImpl.getElementById("content") ||
    documentImpl.body;
  clearChatPreviewState(state);

  state.pendingUserEl = documentImpl.createElement("div");
  state.pendingUserEl.id = "chat-pending-user";
  state.pendingUserEl.className = "user-message chat-pending-user";
  const userContent = createMarkdownBlock(documentImpl, "markdown-content");
  setMarkdownContent(userContent, renderMarkdown(text));
  state.pendingUserEl.appendChild(userContent);
  container.appendChild(state.pendingUserEl);

  state.chatPreviewEl = createAssistantPreview(documentImpl, { waiting: true, windowImpl });
  container.appendChild(state.chatPreviewEl);

  startWorkingAnimation(state, { setIntervalImpl, windowImpl });

  if (shouldFollow()) {
    forceFollowToBottom(false);
    scrollAfterLayout(false, state.chatPreviewEl);
  }
  return true;
}

export function renderChatPreviewState(
  payload: unknown,
  state: ChatPreviewState,
  {
    documentImpl = document,
    windowImpl = typeof window !== "undefined" ? window : null,
    renderMarkdown = (content) => content,
    shouldFollow = () => false,
    forceFollowToBottom = () => {},
    scrollAfterLayout = () => {},
    setIntervalImpl = setInterval,
  }: PreviewRenderOptions = {},
): boolean {
  if (!isUnknownRecord(payload) || typeof payload.content !== "string") return false;
  const nextTurnId = typeof payload.turnId === "string" ? payload.turnId : null;
  const nextItemId = typeof payload.itemId === "string" ? payload.itemId : null;
  if (nextItemId && state.previewItemId && nextItemId !== state.previewItemId) {
    clearChatPreviewState(state);
  }
  const container =
    documentImpl.getElementById("messages") ||
    documentImpl.getElementById("content") ||
    documentImpl.body;
  if (!state.chatPreviewEl) {
    state.chatPreviewEl = createAssistantPreview(documentImpl, { windowImpl });
    container.appendChild(state.chatPreviewEl);
    startWorkingAnimation(state, { setIntervalImpl, windowImpl });
  }
  if (nextTurnId) state.previewTurnId = nextTurnId;
  if (nextItemId) state.previewItemId = nextItemId;

  const activeMsg = getActiveMessage(payload.content);
  if (activeMsg) {
    state.activePreviewMessage = activeMsg;
    const textEl = state.chatPreviewEl.querySelector(".preview-text");
    if (textEl) textEl.textContent = activeMsg;
  }

  state.chatPreviewEl.classList.remove("chat-preview-waiting");
  const content = state.chatPreviewEl.querySelector(".message-content");
  setMarkdownContent(content, renderMarkdown(payload.content));
  if (payload.done) finishChatPreviewState(state);
  else state.chatPreviewEl.classList.remove("done");
  if (shouldFollow()) {
    forceFollowToBottom(false);
    scrollAfterLayout(false, state.chatPreviewEl);
  }
  return true;
}
