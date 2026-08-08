import { Effect, Schema } from "effect";
import { DecodeError, HttpError, NetworkError } from "../../../lib/errors.js";
import { runPromise } from "../../../lib/runtime.js";

const SOURCE_ORDER = ["prompt", "skill", "extension"] as const;
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  prompt: "Prompts",
  skill: "Skills",
  extension: "Extensions",
};
const PALETTE_SOURCES = new Set<string>(SOURCE_ORDER);

export interface SlashCommand {
  readonly name?: string;
  readonly description?: string;
  readonly source?: string;
}
interface Trigger {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}
interface CommandGroup {
  readonly source: string;
  readonly label: string;
  readonly items: ReadonlyArray<SlashCommand>;
  readonly _source?: string;
}
interface SlashChatApi {
  getCommands(
    sessionId: string,
    options: { readonly load: boolean },
  ): Promise<{ readonly ok: boolean; readonly status?: number; json(): Promise<unknown> }>;
}
interface SlashOptions {
  readonly documentImpl?: Document;
  readonly sessionId?: string;
  readonly chatApi?: SlashChatApi;
  readonly escapeHtml?: (value: string) => string;
}

const CommandsResponseSchema = Schema.Struct({
  commands: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
        source: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

export function isPaletteCommand(command: SlashCommand | null | undefined): boolean {
  return command?.source !== undefined && PALETTE_SOURCES.has(command.source);
}

export function parseSlashTrigger(text: unknown, caret: number): Trigger | null {
  if (typeof text !== "string" || !text.startsWith("/")) return null;
  const matchedIndex = text.match(/\s/)?.index;
  const tokenEnd = matchedIndex ?? text.length;
  if (caret > tokenEnd) return null;
  return { query: text.slice(1, tokenEnd), start: 0, end: tokenEnd };
}

export function filterCommands(
  commands: ReadonlyArray<SlashCommand> | null | undefined,
  query: string,
): SlashCommand[] {
  const list = commands ?? [];
  const normalized = query.toLowerCase();
  return normalized
    ? list.filter((command) => (command.name ?? "").toLowerCase().includes(normalized))
    : [...list];
}

export function groupCommands(
  commands: ReadonlyArray<SlashCommand> | null | undefined,
): CommandGroup[] {
  const buckets = new Map<string, SlashCommand[]>();
  for (const command of commands ?? []) {
    const source = command.source ?? "other";
    const bucket = buckets.get(source) ?? [];
    bucket.push(command);
    buckets.set(source, bucket);
  }
  const groups: CommandGroup[] = [];
  for (const source of SOURCE_ORDER) {
    const items = buckets.get(source);
    if (items) {
      groups.push({ source, label: SOURCE_LABELS[source] ?? source, items });
      buckets.delete(source);
    }
  }
  for (const [source, items] of buckets)
    groups.push({ source, label: "Other", items, _source: source });
  return groups;
}

export function renderCommandList(
  commands: ReadonlyArray<SlashCommand> | null | undefined,
  {
    query = "",
    escapeHtml = String,
    loading = false,
  }: {
    readonly query?: string;
    readonly escapeHtml?: (value: string) => string;
    readonly loading?: boolean;
  } = {},
): string {
  if (loading) return '<div class="slash-empty">Loading commands...</div>';
  const filtered = filterCommands(commands, query);
  if (filtered.length === 0) return '<div class="slash-empty">No commands match</div>';
  return groupCommands(filtered)
    .map((group) => {
      const items = group.items
        .map((command) => {
          const name = command.name ?? "";
          const description = command.description ?? "";
          const descriptionHtml = description
            ? `<span class="slash-item-desc">${escapeHtml(description)}</span>`
            : "";
          return `<button type="button" class="slash-item" data-insert="${escapeHtml(name)}"><span class="slash-item-name">/${escapeHtml(name)}</span>${descriptionHtml}</button>`;
        })
        .join("");
      return `<div class="slash-group">${escapeHtml(group.label)}</div>${items}`;
    })
    .join("");
}

export function setupSlashCommands(options: SlashOptions = {}): {
  handleKeydown(event: KeyboardEvent): boolean;
  open?(): void;
  close?(): void;
  isOpen?(): boolean;
  refresh?(): void;
  dispose?(): void;
} {
  const documentImpl = options.documentImpl ?? document;
  const sessionId = options.sessionId ?? "";
  const chatApi = options.chatApi;
  const escapeHtml = options.escapeHtml ?? String;
  const textarea = documentImpl.querySelector<HTMLTextAreaElement>("#pi-chat-message");
  const popup = documentImpl.querySelector<HTMLElement>("#pi-chat-slash-popup");
  const list = documentImpl.querySelector<HTMLElement>("#pi-chat-slash-list");
  if (!textarea || !popup || !list) return { handleKeydown: () => false, dispose: () => undefined };
  let allCommands: SlashCommand[] = [];
  let loaded = false;
  let loading = false;
  let trigger: Trigger | null = null;
  let disposed = false;
  const isOpen = () => popup.style.display !== "none" && popup.style.display !== "";
  const items = () => list.querySelectorAll<HTMLButtonElement>(".slash-item");
  const setActive = (index: number) => {
    const all = items();
    const clamped = Math.max(0, Math.min(index, all.length - 1));
    list.dataset.activeIndex = String(all.length ? clamped : -1);
    all.forEach((element, itemIndex) => element.classList.toggle("active", itemIndex === clamped));
    all[clamped]?.scrollIntoView?.({ block: "nearest" });
  };
  const render = () => {
    list.innerHTML = renderCommandList(allCommands, {
      query: trigger?.query ?? "",
      escapeHtml,
      loading: loading && !loaded,
    });
    setActive(0);
  };
  const load = () => {
    if (!chatApi || loaded || loading) return;
    loading = true;
    render();
    const url = "/api/commands";
    const effect = Effect.tryPromise({
      try: () => chatApi.getCommands(sessionId, { load: true }),
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
        Schema.decodeUnknownEffect(CommandsResponseSchema)(value).pipe(
          Effect.mapError(() => new DecodeError({ url, issue: "invalid commands response" })),
        ),
      ),
      Effect.match({
        onFailure: () => {
          if (!disposed) allCommands = [];
        },
        onSuccess: (data) => {
          if (!disposed) allCommands = (data.commands ?? []).filter(isPaletteCommand);
        },
      }),
      Effect.andThen(
        Effect.sync(() => {
          if (disposed) return;
          loaded = true;
          loading = false;
          if (isOpen()) render();
        }),
      ),
    );
    void runPromise(effect);
  };
  const open = () => {
    popup.style.display = "block";
    render();
    load();
  };
  const close = () => {
    popup.style.display = "none";
    trigger = null;
  };
  const refresh = () => {
    const next = parseSlashTrigger(
      textarea.value,
      textarea.selectionStart ?? textarea.value.length,
    );
    if (!next) {
      if (isOpen()) close();
      return;
    }
    const wasOpen = isOpen();
    trigger = next;
    if (wasOpen) render();
    else open();
  };
  const insert = (name: string) => {
    if (!trigger) return;
    const replacement = `/${name} `;
    textarea.value =
      textarea.value.slice(0, trigger.start) + replacement + textarea.value.slice(trigger.end);
    textarea.selectionStart = textarea.selectionEnd = trigger.start + replacement.length;
    close();
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
  const onListClick = (event: MouseEvent): void => {
    const item =
      event.target instanceof Element ? event.target.closest<HTMLElement>(".slash-item") : null;
    if (item) insert(item.dataset.insert ?? "");
  };
  const onDocumentClick = (event: MouseEvent): void => {
    const target = event.target;
    if (isOpen() && target instanceof Node && !popup.contains(target) && target !== textarea)
      close();
  };
  textarea.addEventListener("input", refresh);
  list.addEventListener("click", onListClick);
  documentImpl.addEventListener("click", onDocumentClick);
  return {
    handleKeydown,
    open,
    close,
    isOpen,
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      textarea.removeEventListener("input", refresh);
      list.removeEventListener("click", onListClick);
      documentImpl.removeEventListener("click", onDocumentClick);
      close();
    },
  };
}
