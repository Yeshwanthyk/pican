import { Effect, Schema } from "effect";
import { DecodeError, HttpError, NetworkError } from "../../../lib/errors.js";
import { runPromise } from "../../../lib/runtime.js";

interface AtTrigger {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

interface FileItem {
  readonly path?: string;
  readonly isDir?: boolean;
}

interface MentionChatApi {
  getFiles(
    sessionId: string,
    query: string,
    options: { readonly signal?: AbortSignal },
  ): Promise<{ readonly ok: boolean; readonly status?: number; json(): Promise<unknown> }>;
}
type TimerToken = number | ReturnType<typeof setTimeout>;

interface MentionOptions {
  readonly documentImpl?: Document;
  readonly windowImpl?: Window & typeof globalThis;
  readonly sessionId?: string;
  readonly chatApi?: MentionChatApi;
  readonly escapeHtml?: (value: string) => string;
  readonly debounceMs?: number;
  readonly setTimeoutImpl?: (callback: () => void, delay: number) => TimerToken;
  readonly clearTimeoutImpl?: (timer: TimerToken) => void;
  readonly AbortControllerImpl?: typeof AbortController;
}

const FileResponseSchema = Schema.Struct({
  files: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.optionalKey(Schema.String),
        isDir: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});

export function parseAtTrigger(text: unknown, caret?: number | null): AtTrigger | null {
  if (typeof text !== "string") return null;
  const end = caret ?? text.length;
  let at = -1;
  for (let i = end - 1; i >= 0; i -= 1) {
    const ch = text[i] ?? "";
    if (ch === "@") {
      at = i;
      break;
    }
    if (/\s/.test(ch)) return null;
  }
  if (at < 0 || (at > 0 && !/\s/.test(text[at - 1] ?? ""))) return null;
  return { query: text.slice(at + 1, end), start: at, end };
}

export function renderFileList(
  files: ReadonlyArray<FileItem> | null | undefined,
  {
    escapeHtml = String,
    loading = false,
  }: { readonly escapeHtml?: (value: string) => string; readonly loading?: boolean } = {},
): string {
  if (loading) return '<div class="slash-empty">Searching files...</div>';
  const list = files ?? [];
  if (list.length === 0) return '<div class="slash-empty">No files match</div>';
  return list
    .map((file) => {
      const path = file.path ?? "";
      const display = file.isDir ? `${path}/` : path;
      return `<button type="button" class="slash-item" data-insert="${escapeHtml(path)}" data-isdir="${file.isDir ? "1" : ""}"><span class="slash-item-name">${escapeHtml(display)}</span></button>`;
    })
    .join("");
}

export function setupMentionAutocomplete(options: MentionOptions = {}) {
  const documentImpl = options.documentImpl ?? document;
  const windowImpl = options.windowImpl ?? window;
  const sessionId = options.sessionId ?? "";
  const chatApi = options.chatApi;
  const escapeHtml = options.escapeHtml ?? String;
  const debounceMs = options.debounceMs ?? 120;
  const setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout.bind(globalThis);
  const AbortControllerImpl = options.AbortControllerImpl ?? windowImpl.AbortController;
  const textarea = documentImpl.querySelector<HTMLTextAreaElement>("#pi-chat-message");
  const popup = documentImpl.querySelector<HTMLElement>("#pi-chat-mention-popup");
  const list = documentImpl.querySelector<HTMLElement>("#pi-chat-mention-list");
  if (!textarea || !popup || !list) return { handleKeydown: () => false };

  let trigger: AtTrigger | null = null;
  let debounceTimer: TimerToken | null = null;
  let inflight: AbortController | null = null;
  let reqSeq = 0;
  const isOpen = () => popup.style.display !== "none" && popup.style.display !== "";
  const items = () => list.querySelectorAll<HTMLButtonElement>(".slash-item");
  const setActive = (index: number) => {
    const all = items();
    const clamped = Math.max(0, Math.min(index, all.length - 1));
    list.dataset.activeIndex = String(all.length ? clamped : -1);
    all.forEach((element, itemIndex) => element.classList.toggle("active", itemIndex === clamped));
    all[clamped]?.scrollIntoView?.({ block: "nearest" });
  };
  const renderFiles = (files: ReadonlyArray<FileItem>, loading: boolean) => {
    list.innerHTML = renderFileList(files, { escapeHtml, loading });
    setActive(0);
  };
  const open = () => {
    popup.style.display = "block";
  };
  const close = () => {
    popup.style.display = "none";
    trigger = null;
    if (debounceTimer !== null) clearTimeoutImpl(debounceTimer);
    debounceTimer = null;
    inflight?.abort();
    inflight = null;
  };
  const fetchAndRender = () => {
    if (!trigger || !chatApi) return;
    const seq = ++reqSeq;
    inflight?.abort();
    inflight = new AbortControllerImpl();
    const url = "/api/files";
    const effect = Effect.tryPromise({
      try: () => chatApi.getFiles(sessionId, trigger?.query ?? "", { signal: inflight?.signal }),
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed(response)
          : Effect.fail(new HttpError({ status: response.status ?? 0, url, body: "" })),
      ),
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json(),
          catch: () => new DecodeError({ url, issue: "invalid JSON" }),
        }),
      ),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(FileResponseSchema)(value).pipe(
          Effect.mapError(() => new DecodeError({ url, issue: "invalid files response" })),
        ),
      ),
      Effect.match({
        onFailure: () => {
          if (seq !== reqSeq || !isOpen()) return;
          renderFiles([], false);
        },
        onSuccess: (data) => {
          if (seq === reqSeq && isOpen()) renderFiles(data.files ?? [], false);
        },
      }),
    );
    void runPromise(effect);
  };
  const refresh = () => {
    const next = parseAtTrigger(textarea.value, textarea.selectionStart);
    if (!next) {
      if (isOpen()) close();
      return;
    }
    trigger = next;
    if (!isOpen()) {
      open();
      renderFiles([], true);
    }
    if (debounceTimer !== null) clearTimeoutImpl(debounceTimer);
    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = null;
      fetchAndRender();
    }, debounceMs);
  };
  const insert = (path: string, isDir: boolean) => {
    if (!trigger) return;
    const replacement = isDir ? `@${path}/` : `${path} `;
    textarea.value =
      textarea.value.slice(0, trigger.start) + replacement + textarea.value.slice(trigger.end);
    textarea.selectionStart = textarea.selectionEnd = trigger.start + replacement.length;
    if (!isDir) close();
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const handleKeydown = (event: KeyboardEvent): boolean => {
    if (!isOpen()) return false;
    const all = items();
    const active = Number.parseInt(list.dataset.activeIndex ?? "-1", 10);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(active + (event.key === "ArrowDown" ? 1 : -1));
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const item = all[active];
      if (!item) return false;
      event.preventDefault();
      item.click();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  };
  textarea.addEventListener("input", refresh);
  list.addEventListener("click", (event) => {
    const item =
      event.target instanceof Element ? event.target.closest<HTMLElement>(".slash-item") : null;
    if (item) insert(item.dataset.insert ?? "", item.dataset.isdir === "1");
  });
  documentImpl.addEventListener("click", (event) => {
    const target = event.target;
    if (isOpen() && target instanceof Node && !popup.contains(target) && target !== textarea)
      close();
  });
  return { handleKeydown, open, close, isOpen, refresh };
}
