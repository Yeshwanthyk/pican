import type { ModelOption } from "../../../session/chat/chat-selectors";
import type { SessionEntry } from "../../../session/data/session-types";
import type { setupMentionAutocomplete } from "./mention-autocomplete";
import type { setupModelSelector } from "./model-selector";
import type { setupSlashCommands } from "./slash-command";
import type { setupThinkingLevelSelector } from "./thinking-selector";

type SearchParamsConstructor = new (init?: string) => Pick<URLSearchParams, "get">;

export interface ChatApiResponse {
  readonly ok: boolean;
  readonly status?: number;
  json(): Promise<unknown>;
}

export interface ChatApiLike {
  listModels(sessionId?: string): Promise<ChatApiResponse>;
  setModel(
    sessionId: string,
    model: { readonly provider: string; readonly modelId: string },
  ): Promise<ChatApiResponse>;
  setThinkingLevel(sessionId: string, level: string): Promise<ChatApiResponse>;
  getCommands(sessionId: string, options: { readonly load?: boolean }): Promise<ChatApiResponse>;
  getFiles(
    sessionId: string,
    query: string,
    options: { readonly signal?: AbortSignal },
  ): Promise<ChatApiResponse>;
}

export function chatSessionId({
  documentImpl = document,
  locationImpl = location,
  URLSearchParamsImpl = URLSearchParams,
}: {
  readonly documentImpl?: Document;
  readonly locationImpl?: Pick<Location, "search">;
  readonly URLSearchParamsImpl?: SearchParamsConstructor;
} = {}): string {
  return (
    new URLSearchParamsImpl(locationImpl.search).get("id") ||
    (documentImpl.getElementById("pi-chat-composer") || {}).dataset?.sessionId ||
    ""
  );
}

const noopKeydownSelector = { handleKeydown: () => false };

interface SelectorLoaderOptions {
  readonly documentImpl?: Document;
  readonly windowImpl?: Window & typeof globalThis;
  readonly locationImpl?: Pick<Location, "search">;
  readonly URLSearchParamsImpl?: SearchParamsConstructor;
  readonly entries?: readonly SessionEntry[];
  readonly chatApi?: ChatApiLike;
  readonly escapeHtml?: (text: string) => string;
  readonly modelSelector: {
    readonly setupModelSelector: (options?: Parameters<typeof setupModelSelector>[0]) => {
      open(): void;
      close?(focusTextarea?: boolean): void;
    };
  };
  readonly thinkingSelector: {
    readonly setupThinkingLevelSelector: (
      options?: Parameters<typeof setupThinkingLevelSelector>[0],
    ) => { cycle(): void; open?(): void; close?(): void } | false;
  };
  readonly slashSelector?: { readonly setupSlashCommands?: typeof setupSlashCommands } | null;
  readonly mentionSelector?: {
    readonly setupMentionAutocomplete?: typeof setupMentionAutocomplete;
  } | null;
  readonly setModelLabel?: (label: string) => void;
  readonly setChatStatus?: (message: string, kind: string) => void;
  readonly setThinkingLabel?: (level: string) => void;
  readonly setKnownModelLabel?: (label: string) => void;
  readonly getKnownModelLabel?: () => string;
  readonly setCurrentModelForThinking?: (model: ModelOption | null) => void;
  readonly setWorkerModelUpdate?: (handler: (provider: string, modelId: string) => void) => void;
  readonly getCurrentModelForThinking?: () => ModelOption | null;
  readonly getKnownThinkingLevel?: () => string;
  readonly setKnownThinkingLevel?: (level: string) => void;
}

export function createChatSelectorLoaders({
  documentImpl = document,
  windowImpl = window,
  locationImpl = windowImpl.location,
  URLSearchParamsImpl = URLSearchParams,
  entries = [],
  chatApi,
  escapeHtml = String,
  modelSelector,
  thinkingSelector,
  slashSelector,
  mentionSelector,
  setModelLabel = () => {},
  setChatStatus = () => {},
  setThinkingLabel = () => {},
  setKnownModelLabel = () => {},
  getKnownModelLabel = () => "",
  setCurrentModelForThinking = () => {},
  setWorkerModelUpdate = () => {},
  getCurrentModelForThinking = () => null,
  getKnownThinkingLevel = () => "",
  setKnownThinkingLevel = () => {},
}: SelectorLoaderOptions) {
  const getSessionId = () => chatSessionId({ documentImpl, locationImpl, URLSearchParamsImpl });

  function loadModelSelector() {
    return modelSelector.setupModelSelector({
      documentImpl,
      sessionId: getSessionId(),
      entries,
      chatApi,
      escapeHtml,
      setModelLabel,
      setChatStatus,
      setKnownModelLabel,
      getKnownModelLabel,
      setCurrentModelForThinking,
      setWorkerModelUpdate,
    });
  }

  function loadSlashSelector() {
    if (!slashSelector || typeof slashSelector.setupSlashCommands !== "function") {
      return noopKeydownSelector;
    }
    return slashSelector.setupSlashCommands({
      documentImpl,
      sessionId: getSessionId(),
      chatApi,
      escapeHtml,
    });
  }

  function loadMentionSelector() {
    if (!mentionSelector || typeof mentionSelector.setupMentionAutocomplete !== "function") {
      return noopKeydownSelector;
    }
    return mentionSelector.setupMentionAutocomplete({
      documentImpl,
      windowImpl,
      sessionId: getSessionId(),
      chatApi,
      escapeHtml,
    });
  }

  function loadThinkingSelector() {
    return thinkingSelector.setupThinkingLevelSelector({
      documentImpl,
      windowImpl,
      sessionId: getSessionId(),
      entries,
      getCurrentModel: getCurrentModelForThinking,
      getKnownThinkingLevel,
      setKnownThinkingLevel,
      setThinkingLabel,
      setChatStatus,
      chatApi,
    });
  }

  return {
    loadModelSelector,
    loadThinkingSelector,
    loadSlashSelector,
    loadMentionSelector,
  };
}
