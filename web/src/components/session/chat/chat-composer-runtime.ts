// Live-only DOM/runtime glue for the chat composer, extracted from
// ChatComposer.svelte so the component stays declarative. Kept DI-friendly so
// tests can drive it directly and inject selector implementations.
import { THINKING_LEVELS } from "../../../session/chat/chat-selectors.js";
import type { ModelOption } from "../../../session/chat/chat-selectors.js";
import * as defaultChatApi from "../../../session/chat/chat-api.js";
import type { SessionEntry } from "../../../session/data/session-types.js";
import type { NavigateTo } from "../../../session/session-runtime-context.js";
import { setupModelSelector } from "./model-selector.js";
import { setupThinkingLevelSelector } from "./thinking-selector.js";
import { setupSlashCommands } from "./slash-command.js";
import { setupMentionAutocomplete } from "./mention-autocomplete.js";
import { createContextUsageController } from "./context-usage.js";
import { setupComposerExpansion } from "./composer-expand.js";
import { setupWorkerStatusPolling } from "./worker-status.js";
import { setupAskQuestionHandlers } from "./ask-question-handler.js";
import { readComposerConfig } from "./composer-config.js";
import { getComposerElements } from "./composer-elements.js";
import { setupContextPopover } from "./context-popover.js";
import { setupTextareaControls } from "./textarea-controls.js";
import { setupAttachmentManager } from "./attachment-manager.js";
import { setupCwdCopy } from "./cwd-copy.js";
import { setupComposerHeightVar } from "./composer-height.js";
import { createComposerSendState } from "./composer-send-state.js";
import { getComposerStorage } from "./composer-storage.js";
import { navigateInitialChatLeaf } from "./initial-navigation.js";
import { ChatToolbarState } from "./chat-toolbar-state.svelte.js";
import { setupChatSubmission } from "./chat-submit.js";
import { setupSteerQueue } from "./steer-queue.js";
import { QueueStore } from "./queue-store.svelte.js";
import type { QueueApi } from "./queue-api.js";
import {
  defaultRuntimeCapabilities,
  type CompleteRuntimeCapabilities,
} from "../../../lib/runtime-capabilities.js";
import { createChatSelectorLoaders } from "./selector-loaders.js";
import type { ChatApiLike, ChatApiResponse } from "./selector-loaders.js";

type RuntimeSessionEntry = Omit<SessionEntry, "id"> & { readonly id?: string };

type ComposerChatApi = Partial<ChatApiLike> & {
  readonly cancelChat?: (sessionId: string) => Promise<ChatApiResponse>;
  readonly sendChat?: (sessionId: string, body: FormData) => Promise<ChatApiResponse>;
  readonly getWorkerStatus?: (sessionId: string) => Promise<ChatApiResponse>;
};

interface ChatComposerRuntimeOptions {
  readonly documentImpl?: Document;
  readonly windowImpl?: { readonly location: Location };
  readonly locationImpl?: Location;
  readonly localEntries?: readonly RuntimeSessionEntry[];
  readonly sessionId?: string;
  readonly leafId?: string;
  readonly urlTargetId?: string;
  readonly byId?: ReadonlyMap<string, unknown>;
  readonly navigateTo?: NavigateTo;
  readonly escapeHtml?: (text: string) => string;
  readonly chatApi?: ComposerChatApi;
  readonly chatSelectors?: { readonly THINKING_LEVELS?: readonly string[] };
  readonly modelSelector?: {
    readonly setupModelSelector?: (options?: Parameters<typeof setupModelSelector>[0]) => {
      open(): void;
      close?(focusTextarea?: boolean): void;
    };
  };
  readonly thinkingSelector?: {
    readonly setupThinkingLevelSelector?: (
      options?: Parameters<typeof setupThinkingLevelSelector>[0],
    ) => { cycle(): void; open?(): void; close?(): void } | false;
  };
  readonly slashSelector?: { readonly setupSlashCommands?: typeof setupSlashCommands } | null;
  readonly mentionSelector?: {
    readonly setupMentionAutocomplete?: typeof setupMentionAutocomplete;
  } | null;
  readonly FormDataImpl?: typeof FormData;
  readonly URLSearchParamsImpl?: typeof URLSearchParams;
  readonly CustomEventImpl?: typeof CustomEvent;
  readonly setIntervalImpl?: (handler: () => void, timeout: number) => number | void;
  readonly toolbar?: ChatToolbarState;
  readonly queueStore?: QueueStore;
  readonly queueApi?: QueueApi | null;
  readonly getLiveEntries?: (() => readonly SessionEntry[]) | null;
  readonly capabilities?: CompleteRuntimeCapabilities;
}

export function runChatComposer({
  documentImpl = document,
  windowImpl = window,
  locationImpl = windowImpl.location,
  localEntries = [],
  sessionId = "",
  leafId = "",
  urlTargetId = "",
  byId = new Map(),
  navigateTo = () => {},
  escapeHtml = (text) => String(text),
  chatApi = defaultChatApi,
  chatSelectors = { THINKING_LEVELS },
  modelSelector = { setupModelSelector },
  thinkingSelector = { setupThinkingLevelSelector },
  slashSelector = { setupSlashCommands },
  mentionSelector = { setupMentionAutocomplete },
  FormDataImpl = FormData,
  URLSearchParamsImpl = URLSearchParams,
  CustomEventImpl = CustomEvent,
  setIntervalImpl = setInterval,
  toolbar = new ChatToolbarState(),
  queueStore = new QueueStore(),
  queueApi = null,
  getLiveEntries = null,
  capabilities = defaultRuntimeCapabilities("pi"),
}: ChatComposerRuntimeOptions = {}) {
  const document = documentImpl;
  const window = documentImpl.defaultView ?? globalThis.window;
  const location = locationImpl;
  const entries: SessionEntry[] = localEntries.map((entry, index) => ({
    ...entry,
    id: entry.id ?? `runtime-entry-${index}`,
  }));
  const __piChatApi = {
    ...defaultChatApi,
    ...chatApi,
    cancelChat: chatApi.cancelChat ?? defaultChatApi.cancelChat,
    sendChat: chatApi.sendChat ?? defaultChatApi.sendChat,
    getWorkerStatus: chatApi.getWorkerStatus ?? defaultChatApi.getWorkerStatus,
    listModels: chatApi.listModels ?? defaultChatApi.listModels,
    getCommands: chatApi.getCommands ?? defaultChatApi.getCommands,
    getFiles: chatApi.getFiles ?? defaultChatApi.getFiles,
    setModel: chatApi.setModel ?? defaultChatApi.setModel,
    setThinkingLevel: chatApi.setThinkingLevel ?? defaultChatApi.setThinkingLevel,
  };
  void chatSelectors;
  const __piModelSelector = {
    setupModelSelector: modelSelector.setupModelSelector ?? setupModelSelector,
  };
  const __piThinkingSelector = {
    setupThinkingLevelSelector:
      thinkingSelector.setupThinkingLevelSelector ?? setupThinkingLevelSelector,
  };
  const __piSlashSelector = slashSelector;
  const __piMentionSelector = mentionSelector;
  const FormData = FormDataImpl;
  const URLSearchParams = URLSearchParamsImpl;
  const CustomEvent = CustomEventImpl;
  const setInterval = (handler: () => void, timeout: number): number =>
    setIntervalImpl(handler, timeout) ?? 0;
  let onWorkerModelUpdate: ((provider: string, modelId: string) => void) | null = null;
  let currentModelForThinking: ModelOption | null = null;
  let positionPopover: () => void = () => {};
  const disposables: Array<() => void> = [];
  const contextUsage = createContextUsageController({
    documentImpl: document,
    entries,
    sessionId,
    chatApi: { listModels: __piChatApi.listModels ?? defaultChatApi.listModels },
    getKnownModelLabel: () => toolbar.knownModelLabel,
    positionPopover: () => positionPopover(),
  });
  const updateContextUsage = () => {
    if (capabilities.modelListing) contextUsage.update();
  };
  toolbar.updateContextUsage = updateContextUsage;

  function isMobileTextInputMode(): boolean {
    return !!(
      window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches
    );
  }

  const setChatStatus = toolbar.setStatus;
  const setModelLabel = toolbar.setModelLabel;
  const setThinkingLabel = toolbar.setThinkingLabel;
  const selectorLoaders = createChatSelectorLoaders({
    documentImpl: document,
    windowImpl: window,
    locationImpl: location,
    URLSearchParamsImpl: URLSearchParams,
    entries,
    chatApi: __piChatApi,
    escapeHtml,
    modelSelector: __piModelSelector,
    thinkingSelector: __piThinkingSelector,
    slashSelector: __piSlashSelector,
    mentionSelector: __piMentionSelector,
    setModelLabel,
    setChatStatus,
    setThinkingLabel,
    setKnownModelLabel: toolbar.setKnownModelLabel,
    getKnownModelLabel: toolbar.getKnownModelLabel,
    setCurrentModelForThinking: (model) => {
      currentModelForThinking = model;
    },
    setWorkerModelUpdate: (handler) => {
      onWorkerModelUpdate = handler;
    },
    getCurrentModelForThinking: () => currentModelForThinking,
    getKnownThinkingLevel: toolbar.getKnownThinkingLevel,
    setKnownThinkingLevel: toolbar.setKnownThinkingLevel,
  });

  function setupPiChatComposer(): boolean {
    const form = document.querySelector<HTMLFormElement>("#pi-chat-composer");
    const composerConfig = readComposerConfig({ form, setChatStatus });
    if (!composerConfig.ready) return false;
    const { sessionId } = composerConfig;
    const {
      textarea,
      fileInput,
      attachButton,
      attachmentList,
      sendButton,
      cancelButton,
      queueButton,
      shell,
      expandButton,
    } = getComposerElements({ documentImpl: document, form });

    const { update: updateComposerHeightVar } = setupComposerHeightVar({
      documentImpl: document,
      windowImpl: window,
      form,
    });

    // Expand/collapse the composer for larger typing area. State persists
    // per-session in localStorage.
    let attachments: ReturnType<typeof setupAttachmentManager> | null = null;
    const sendState = createComposerSendState({
      textarea,
      sendButton,
      getAttachments: () => attachments ?? { hasAttachments: () => false },
      canSend: () => !toolbar.isRunning || capabilities.steer,
    });
    const updateSendEnabled = sendState.updateSendEnabled;

    attachments = setupAttachmentManager({
      documentImpl: document,
      windowImpl: window,
      textarea,
      fileInput,
      attachButton,
      attachmentList,
      updateSendEnabled,
      allowImages: capabilities.images,
      allowFiles: capabilities.files,
    });

    const textareaControls = setupTextareaControls({
      windowImpl: window,
      textarea,
      shell,
      form,
      isMobileTextInputMode,
      getSlashSelector: () => _slashSelectorApi,
      getMentionSelector: () => _mentionSelectorApi,
      getThinkingSelector: () => _thinkingSelectorApi || null,
      getModelSelector: () => _modelSelectorApi,
      updateSendEnabled,
      updateComposerHeight: updateComposerHeightVar,
    });
    const autoResizeTextarea = textareaControls.autoResize;

    setupComposerExpansion({
      sessionId,
      shell,
      expandButton,
      textarea,
      storage: getComposerStorage({ windowImpl: window }),
      onHeightChange: updateComposerHeightVar,
    });

    if (!textarea || !sendButton) return false;

    function setStatus(text: string, cls = ""): void {
      setChatStatus(text, cls);
    }

    const submission = setupChatSubmission({
      windowImpl: window,
      form,
      textarea,
      sendButton,
      cancelButton,
      attachments,
      chatApi: __piChatApi,
      sessionId,
      setStatus,
      autoResizeTextarea,
      updateSendEnabled,
      FormDataImpl: FormData,
      CustomEventImpl: CustomEvent,
      canSend: () => !toolbar.isRunning || capabilities.steer,
    });

    if (capabilities.userQuestions) {
      setupAskQuestionHandlers({
        documentImpl: document,
        sendChatMessage: submission.sendChatMessage,
      });
    }

    if (capabilities.persistentQueue) {
      setupSteerQueue({
        windowImpl: window,
        store: queueStore,
        queueButton,
        textarea,
        attachments,
        sendChatMessage: submission.sendChatMessage,
        autoResizeTextarea,
        updateSendEnabled,
        queueApi,
        getLiveEntries,
      });
    }

    const workerStatus = setupWorkerStatusPolling({
      windowImpl: window,
      chatApi: __piChatApi,
      sessionId,
      setStatus,
      setModelLabel,
      setThinkingLabel,
      updateContextUsage,
      getKnownModelLabel: toolbar.getKnownModelLabel,
      setKnownModelLabel: toolbar.setKnownModelLabel,
      getKnownThinkingLevel: toolbar.getKnownThinkingLevel,
      setKnownThinkingLevel: toolbar.setKnownThinkingLevel,
      getWorkerModelUpdate: () => onWorkerModelUpdate,
      setIntervalImpl: setInterval,
      CustomEventImpl: CustomEvent,
    });
    submission.setRefreshWorkerStatus(workerStatus.refresh);
    disposables.push(workerStatus.dispose);

    // Keep phones compact until the user taps the input; desktop retains its
    // existing ready-to-type autofocus behavior.
    const isMobileLayout = !!window.matchMedia?.("(max-width: 900px)").matches;
    if (!isMobileLayout && textarea && typeof textarea.focus === "function") {
      textarea.focus();
    }

    const contextPopover = setupContextPopover({
      documentImpl: document,
      windowImpl: window,
      updateContextUsage,
    });
    positionPopover = contextPopover.position;

    return true;
  }

  let _modelSelectorApi: { open?(): void } | null = null;
  let _thinkingSelectorApi: { cycle?(): void } | null = null;
  let _slashSelectorApi: { handleKeydown?(event: KeyboardEvent): boolean } | null = null;
  let _mentionSelectorApi: { handleKeydown?(event: KeyboardEvent): boolean } | null = null;

  function initPiChatControls(): void {
    setupCwdCopy({ documentImpl: document, windowImpl: window });
    if (!setupPiChatComposer()) return;

    _modelSelectorApi =
      capabilities.modelListing && capabilities.modelSwitching
        ? selectorLoaders.loadModelSelector()
        : null;
    _thinkingSelectorApi =
      capabilities.effortSelection || capabilities.reasoningSelection
        ? selectorLoaders.loadThinkingSelector() || null
        : null;
    _slashSelectorApi = capabilities.slashCommands ? selectorLoaders.loadSlashSelector() : null;
    _mentionSelectorApi = capabilities.files ? selectorLoaders.loadMentionSelector() : null;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPiChatControls);
  } else {
    initPiChatControls();
  }

  navigateInitialChatLeaf({ entries, leafId, urlTargetId, byId, navigateTo });

  return {
    dispose: () => {
      disposables.splice(0).forEach((dispose) => dispose?.());
    },
  };
}
