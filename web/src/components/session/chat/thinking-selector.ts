import { Effect, Schema } from "effect";
import { DecodeError, NetworkError, describeError } from "../../../lib/errors.js";
import { runPromise } from "../../../lib/runtime.js";
import {
  THINKING_LEVELS,
  detectCurrentThinkingLevel,
  supportedThinkingLevels,
} from "../../../session/chat/chat-selectors.js";
import type { ModelOption } from "../../../session/chat/chat-selectors.js";

type SessionEntries = Parameters<typeof detectCurrentThinkingLevel>[0];
interface ThinkingChatApi {
  setThinkingLevel(
    sessionId: string,
    level: string,
  ): Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;
}
interface ThinkingOptions {
  readonly documentImpl?: Document;
  readonly windowImpl?: Window & typeof globalThis;
  readonly sessionId?: string;
  readonly entries?: SessionEntries;
  readonly getCurrentModel?: () => ModelOption | null;
  readonly getKnownThinkingLevel?: () => string;
  readonly setKnownThinkingLevel?: (level: string) => void;
  readonly setThinkingLabel?: (level: string) => void;
  readonly setChatStatus?: (message: string, kind: string) => void;
  readonly chatApi?: ThinkingChatApi;
}
interface ThinkingController {
  open(): void;
  close(): void;
  cycle(): Promise<void>;
}
class ThinkingUpdateError extends Schema.TaggedErrorClass<ThinkingUpdateError>()(
  "ThinkingUpdateError",
  { message: Schema.String },
) {}
const ThinkingResponseSchema = Schema.Struct({
  thinkingLevel: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

export function renderThinkingLevelList({
  levels = THINKING_LEVELS,
  selectedLevel = "",
  currentModel = null,
}: {
  readonly levels?: ReadonlyArray<string>;
  readonly selectedLevel?: string;
  readonly currentModel?: ModelOption | null;
} = {}): string {
  const supported = supportedThinkingLevels(currentModel, levels);
  return levels
    .map((level) => {
      const active = level === selectedLevel ? " selected" : "";
      const unavailable = !supported.includes(level);
      const disabled = unavailable ? ' disabled title="Not supported by current model"' : "";
      return `<button type="button" class="thinking-level-item thinking-${level}${active}" data-level="${level}"${disabled}>${unavailable ? `${level} (unsupported)` : level}</button>`;
    })
    .join("");
}

export function setupThinkingLevelSelector(options: ThinkingOptions): ThinkingController;
export function setupThinkingLevelSelector(options?: ThinkingOptions): ThinkingController | false;
export function setupThinkingLevelSelector(
  options: ThinkingOptions = {},
): ThinkingController | false {
  const documentImpl = options.documentImpl ?? document;
  const windowImpl = options.windowImpl ?? window;
  const sessionId = options.sessionId ?? "";
  const entries = options.entries ?? [];
  const getCurrentModel = options.getCurrentModel ?? (() => null);
  const getKnownThinkingLevel = options.getKnownThinkingLevel ?? (() => "");
  const setKnownThinkingLevel = options.setKnownThinkingLevel ?? (() => undefined);
  const setThinkingLabel = options.setThinkingLabel ?? (() => undefined);
  const setChatStatus = options.setChatStatus ?? (() => undefined);
  const chatApi = options.chatApi;
  const labelButton = documentImpl.querySelector<HTMLButtonElement>("#pi-chat-thinking-label");
  const popup = documentImpl.querySelector<HTMLElement>("#pi-chat-thinking-popup");
  const list = documentImpl.querySelector<HTMLElement>("#pi-chat-thinking-list");
  if (!labelButton || !popup || !list) return false;
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let queuedCycles = 0;
  let confirmed = getKnownThinkingLevel() || "";
  const render = (selectedLevel: string) => {
    list.innerHTML = renderThinkingLevelList({ selectedLevel, currentModel: getCurrentModel() });
  };
  const open = () => {
    popup.style.display = "flex";
    render(getKnownThinkingLevel());
    const rect = labelButton.getBoundingClientRect();
    const minWidth = 120;
    let left = Math.max(4, rect.right - minWidth);
    if (left + minWidth > windowImpl.innerWidth - 4) left = windowImpl.innerWidth - minWidth - 4;
    popup.style.bottom = `${windowImpl.innerHeight - rect.top + 4}px`;
    popup.style.left = `${left}px`;
    popup.style.right = "";
  };
  const close = () => {
    popup.style.display = "none";
  };
  const request = (level: string) => {
    if (!chatApi)
      return Effect.fail(new ThinkingUpdateError({ message: "set thinking level failed" }));
    const url = "/api/set-thinking-level";
    return Effect.tryPromise({
      try: () => chatApi.setThinkingLevel(sessionId, level),
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json(),
          catch: () => new DecodeError({ url, issue: "invalid JSON" }),
        }).pipe(Effect.map((data) => ({ response, data }))),
      ),
      Effect.flatMap(({ response, data }) =>
        Schema.decodeUnknownEffect(ThinkingResponseSchema)(data).pipe(
          Effect.mapError(() => new DecodeError({ url, issue: "invalid response" })),
          Effect.map((decoded) => ({ response, decoded })),
        ),
      ),
      Effect.flatMap(({ response, decoded }) =>
        response.ok
          ? Effect.succeed(decoded.thinkingLevel ?? level)
          : Effect.fail(
              new ThinkingUpdateError({ message: decoded.error ?? "set thinking level failed" }),
            ),
      ),
    );
  };
  const enqueue = (level: string, currentGeneration: number, decrementCycle: boolean) => {
    const finish = Effect.sync(() => {
      if (decrementCycle) queuedCycles = Math.max(0, queuedCycles - 1);
    });
    const execute = request(level).pipe(
      Effect.catchTags({
        ThinkingUpdateError: ({ message }) => Effect.fail(message),
        NetworkError: (error) => Effect.fail(describeError(error)),
        DecodeError: (error) => Effect.fail(describeError(error)),
      }),
      Effect.match({
        onFailure: (message) => {
          if (currentGeneration !== generation) return;
          setKnownThinkingLevel(confirmed);
          setThinkingLabel(confirmed);
          setChatStatus(message, "error");
        },
        onSuccess: (effectiveLevel) => {
          confirmed = effectiveLevel;
          if (currentGeneration === generation) {
            setKnownThinkingLevel(effectiveLevel);
            setThinkingLabel(effectiveLevel);
          }
        },
      }),
      Effect.andThen(finish),
    );
    const effect = Effect.suspend(() => (currentGeneration !== generation ? finish : execute));
    queue = queue.then(() => runPromise(effect));
    return queue;
  };
  labelButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (popup.style.display !== "none") close();
    else open();
  });
  list.addEventListener("click", (event) => {
    const item =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(".thinking-level-item")
        : null;
    const level = item?.dataset.level;
    if (!item || item.disabled || !level) return;
    close();
    const currentGeneration = ++generation;
    void enqueue(level, currentGeneration, false);
  });
  documentImpl.addEventListener("click", (event) => {
    const target = event.target;
    if (
      popup.style.display !== "none" &&
      target instanceof Node &&
      !popup.contains(target) &&
      target !== labelButton
    )
      close();
  });
  const cycle = (): Promise<void> => {
    const supported = supportedThinkingLevels(getCurrentModel(), THINKING_LEVELS);
    const current = getKnownThinkingLevel() || "";
    const next = supported[(supported.indexOf(current) + 1) % supported.length];
    if (!next || next === current) return Promise.resolve();
    if (queuedCycles === 0) confirmed = current;
    queuedCycles += 1;
    const currentGeneration = ++generation;
    setKnownThinkingLevel(next);
    setThinkingLabel(next);
    return enqueue(next, currentGeneration, true);
  };
  const detected = detectCurrentThinkingLevel(entries);
  if (detected) {
    confirmed = detected;
    setKnownThinkingLevel(detected);
    setThinkingLabel(detected);
  }
  return { open, close, cycle };
}
