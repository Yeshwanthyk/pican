<script module lang="ts">
  import { t } from '../../shared/strings.js';
  import { runChatComposer } from './chat/chat-composer-runtime.js';
  // runChatComposer is the live-only DOM/runtime glue (used by onMount below).
  // Re-exported so existing imports and tests can reach it via this module.
  // eslint-disable-next-line no-import-assign -- re-export of an imported binding; false positive across module/instance scripts
  export { runChatComposer };
</script>

<script lang="ts">
  import { Schema } from 'effect';
  import { onMount } from 'svelte';
  import * as Http from '../../lib/http.js';
  import { runPromise } from '../../lib/runtime.js';
  import {
    isUnknownRecord,
    sessionEntryFromUnknown,
    type SessionEntry,
  } from '../../session/data/session-types.js';
  import { escapeHtml } from '../../session/render/session-format.js';
  import { getSessionRuntime } from '../../session/session-runtime-context.js';
  import * as chatApi from '../../session/chat/chat-api.js';
  import GitFooter from './GitFooter.svelte';
  import PinnedChips from './PinnedChips.svelte';
  import ChatExpandButton from './chat/ChatExpandButton.svelte';
  import ChatSelectorPopups from './chat/ChatSelectorPopups.svelte';
  import ChatToolbar from './chat/ChatToolbar.svelte';
  import ContextUsage from './chat/ContextUsage.svelte';
  import QueuePanel from './chat/QueuePanel.svelte';
  import ExtensionUiCard from './chat/ExtensionUiCard.svelte';
  import TextAttachmentModal from './chat/TextAttachmentModal.svelte';
  import { ChatToolbarState } from './chat/chat-toolbar-state.svelte.js';
  import { QueueStore } from './chat/queue-store.svelte.js';
  import { createQueueApi } from './chat/queue-api.js';
  import { reducePendingExtensionUI, type ExtensionRequest } from './chat/extension-ui-state.js';
  import { showToast } from '../../shared/toast.js';
  import { copyToClipboard } from '../../shared/clipboard.js';
  import {
    defaultRuntimeCapabilities,
    type CompleteRuntimeCapabilities,
  } from '../../lib/runtime-capabilities.js';
  import type { NormalizedSession } from '../../index/sessions.js';
  import type { PinnedTabsModel } from '../../session/pinned-tabs-model.svelte.js';

  let {
    sessionId = '',
    chatAvailable = true,
    chatDisabledReason = '',
    cwd = '',
    modelLabel = '',
    capabilities = defaultRuntimeCapabilities('pi'),
    resumeCommand = '',
    workerStatus = { state: 'idle' },
    initialComposerText = '',
    onComposerTextCapture = () => {},
    pinnedTabs = null,
    currentSession = null,
    currentRunning = false,
    currentWaiting = false,
    onArchiveChange = null,
  }: {
    sessionId?: string;
    chatAvailable?: boolean;
    chatDisabledReason?: string;
    cwd?: string;
    modelLabel?: string;
    capabilities?: CompleteRuntimeCapabilities;
    resumeCommand?: string;
    workerStatus?: { readonly state: string; readonly exitCode?: number };
    initialComposerText?: string;
    onComposerTextCapture?: (text: string) => void;
    pinnedTabs?: PinnedTabsModel | null;
    currentSession?: NormalizedSession | null;
    currentRunning?: boolean;
    currentWaiting?: boolean;
    onArchiveChange?: ((archived: boolean) => void) | null;
  } = $props();

  const workerDown = $derived(workerStatus.state === 'error');
  const effectiveChatAvailable = $derived(chatAvailable && capabilities.chat);
  // An errored worker is evicted by the manager on the next send. Keep the
  // composer usable so that recovery path is reachable without restarting pican.
  const composerAvailable = $derived(effectiveChatAvailable);
  const composerDisabledReason = $derived(chatDisabledReason);
  const safeResumeCommand = $derived(capabilities.resume ? resumeCommand : '');

  async function copyResumeCommand(): Promise<void> {
    if (!safeResumeCommand) return;
    const copied = await copyToClipboard(safeResumeCommand);
    showToast(copied ? t('common.copied') : t('common.copyFailed'));
  }

  const ExtensionRequestSchema = Schema.Struct({
    id: Schema.String,
    method: Schema.optionalKey(Schema.Literals(['select', 'confirm', 'input', 'editor'])),
    title: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(Schema.Array(Schema.String)),
    placeholder: Schema.optionalKey(Schema.String),
    prefill: Schema.optionalKey(Schema.String),
    timeout: Schema.optionalKey(Schema.Number),
    _receivedAt: Schema.optionalKey(Schema.Number),
  });
  const PendingExtensionResponse = Schema.Struct({
    requests: Schema.optionalKey(Schema.Array(ExtensionRequestSchema)),
  });
  const SessionRuntimeModelSchema = Schema.Struct({
    entries: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    leafId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    urlTargetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  });
  const isExtensionRequest = Schema.is(ExtensionRequestSchema);
  const isSessionRuntimeModel = Schema.is(SessionRuntimeModelSchema);
  const TestHookHostSchema = Schema.Struct({
    __PI_TEST_CHAT_COMPOSER_HOOK__: Schema.optionalKey(Schema.Unknown),
  });
  const isTestHookHost = Schema.is(TestHookHostSchema);

  const getTestHook = (host: unknown): (() => void) | undefined => {
    if (!isTestHookHost(host)) return undefined;
    const hook = host.__PI_TEST_CHAT_COMPOSER_HOOK__;
    return typeof hook === 'function' ? (hook as () => void) : undefined;
  };

  // Reactive toolbar state owned here so the live runtime can mutate it while
  // <ChatToolbar> renders from it.
  const toolbar = new ChatToolbarState();
  // Reactive queue panel state — shared with chat-composer-runtime so its
  // steer/queue glue mutates the same items <QueuePanel> renders. The queued
  // items live on the server (chat_queue table); we hydrate on mount and
  // re-fetch on SSE 'queue' events so other tabs (and the autonomous
  // backend drainer) stay in sync.
  const queueApi = (() =>
    sessionId
      ? capabilities.persistentQueue
        ? createQueueApi({
            sessionId,
            fetchImpl: typeof window !== 'undefined' ? window.fetch.bind(window) : undefined,
          })
        : null
      : null)();
  const queueStore = new QueueStore({ api: queueApi });
  let pendingExtensionUI = $state<ExtensionRequest[]>([]);
  const resolvedExtensionUI: string[] = [];

  function resolveExtensionUI(id: string): void {
    if (id && !resolvedExtensionUI.includes(id)) resolvedExtensionUI.push(id);
    pendingExtensionUI = reducePendingExtensionUI(pendingExtensionUI, { type: 'resolve', id });
  }

  // The composer runtime lives in <script module> (runChatComposer). It reads the
  // shared model + navigateTo (owned by SessionPage runtime context) at mount —
  // both are ready before this onMount. <LiveReload> mounts first, so its
  // pi-chat-message-sent listener is attached before the user can send. Live-only.
  onMount(() => {
    if (!effectiveChatAvailable) return;
    const target = window;
    const runtime = getSessionRuntime();
    const model = isSessionRuntimeModel(runtime.model) ? runtime.model : null;
    const liveEntries = (): SessionEntry[] =>
      Array.isArray(model?.entries)
        ? model.entries.flatMap((entry) => {
            const parsed = sessionEntryFromUnknown(entry);
            return parsed ? [parsed] : [];
          })
        : [];
    const entries = liveEntries();
    getTestHook(globalThis)?.();
    const composerRuntime = runChatComposer({
      documentImpl: document,
      windowImpl: target,
      locationImpl: target.location,
      localEntries: entries,
      sessionId,
      leafId: typeof model?.leafId === 'string' ? model.leafId : '',
      urlTargetId: typeof model?.urlTargetId === 'string' ? model.urlTargetId : '',
      byId: new Map(entries.flatMap((entry) => (entry.id ? [[entry.id, entry]] : []))),
      // Live getter: steer-queue uses this on every pi-session-reload to look
      // for a matching user entry and clear the corresponding steer chip once
      // pi has folded the steer into the conversation.
      getLiveEntries: liveEntries,
      navigateTo: runtime.navigateTo ?? undefined,
      escapeHtml: (text: unknown) => escapeHtml(text, { documentImpl: document }),
      chatApi,
      FormDataImpl: target.FormData,
      URLSearchParamsImpl: target.URLSearchParams,
      CustomEventImpl: target.CustomEvent,
      setIntervalImpl: target.setInterval.bind(target),
      toolbar,
      queueStore,
      queueApi,
      capabilities,
      initialComposerText,
      onComposerTextCapture,
    });

    // Initial hydration from the server-side queue + subscribe to SSE 'queue'
    // events so changes from the autonomous drainer (or another tab) show up
    // immediately. The EventSource is shared with <LiveReload> — both attach
    // their own listeners.
    if (capabilities.persistentQueue) void queueStore.refresh?.();
    const onQueueEvent = (): void => {
      void queueStore.refresh?.();
    };
    const onExtensionRequest = (event: Event): void => {
      if (!(event instanceof CustomEvent) || !isExtensionRequest(event.detail)) return;
      if (resolvedExtensionUI.includes(event.detail.id)) return;
      pendingExtensionUI = reducePendingExtensionUI(pendingExtensionUI, {
        type: 'add',
        request: event.detail,
      });
    };
    const onExtensionResolved = (event: Event): void => {
      if (
        event instanceof CustomEvent &&
        isUnknownRecord(event.detail) &&
        typeof event.detail.id === 'string'
      )
        resolveExtensionUI(event.detail.id);
    };
    const onExtensionNotify = (event: Event): void => {
      const notification =
        event instanceof CustomEvent && isUnknownRecord(event.detail) ? event.detail : {};
      showToast(
        typeof notification.message === 'string'
          ? notification.message
          : t('extensionUi.notification'),
        {
          id: 'extension-notify',
          duration: 6000,
          title: typeof notification.type === 'string' ? notification.type : '',
        },
      );
    };
    if (capabilities.persistentQueue) target.addEventListener('pi-queue-event', onQueueEvent);
    target.addEventListener('pi-extension-ui-request', onExtensionRequest);
    target.addEventListener('pi-extension-ui-resolved', onExtensionResolved);
    target.addEventListener('pi-extension-notify', onExtensionNotify);
    if (capabilities.interactiveApprovals || capabilities.userQuestions) {
      void runPromise(
        Http.get(
          '/api/extension-ui/pending?session=' + encodeURIComponent(sessionId),
          PendingExtensionResponse,
        ),
      ).then(
        (data) => {
          for (const request of data.requests ?? []) {
            onExtensionRequest(new CustomEvent('pi-extension-ui-request', { detail: request }));
          }
        },
        () => undefined,
      );
    }
    return () => {
      composerRuntime?.dispose?.();
      target.removeEventListener('pi-queue-event', onQueueEvent);
      target.removeEventListener('pi-extension-ui-request', onExtensionRequest);
      target.removeEventListener('pi-extension-ui-resolved', onExtensionResolved);
      target.removeEventListener('pi-extension-notify', onExtensionNotify);
    };
  });
</script>

{#if !effectiveChatAvailable}
  <div class="pi-chat-composer pi-chat-composer--view-only">
    <button
      type="button"
      class="plain-state plain-state--view-only"
      title={t('session.copyResumeCommand', { command: safeResumeCommand })}
      disabled={!safeResumeCommand}
      onclick={copyResumeCommand}
      >{t('session.viewOnlyResume', { command: safeResumeCommand })}</button
    >
    {#if pinnedTabs && currentSession}
      <PinnedChips
        model={pinnedTabs}
        {currentSession}
        {currentRunning}
        {currentWaiting}
        canCreate={capabilities.create}
        {onArchiveChange}
      />
    {/if}
  </div>
{:else}<form
    id="pi-chat-composer"
    class="pi-chat-composer"
    data-session-id={sessionId}
    data-chat-available={composerAvailable}
    data-chat-disabled-reason={composerDisabledReason}
  >
    <input
      id="pi-chat-images"
      name="images"
      type="file"
      accept="image/*"
      multiple
      hidden
      disabled={!composerAvailable || !capabilities.images}
    />
    {#if !workerDown && (capabilities.interactiveApprovals || capabilities.userQuestions) && pendingExtensionUI.length > 0}
      <div class="extension-ui-stack">
        {#each pendingExtensionUI as request (request.id)}
          <ExtensionUiCard {request} {sessionId} onResolved={resolveExtensionUI} />
        {/each}
      </div>
    {/if}
    {#if !workerDown && capabilities.persistentQueue}<QueuePanel store={queueStore} />{/if}
    <div class="pi-chat-shell composer-collapsed">
      <ChatExpandButton chatAvailable={composerAvailable} />
      {#if cwd}<div class="pi-chat-toolbar pi-chat-cwd-bar">
          <span class="pi-chat-cwd" title={t('composer.copyPath')} data-cwd={cwd}>cwd: {cwd}</span
          ><span class="pi-chat-focus-shortcut">{t('composer.focusShortcut')}</span>
        </div>{/if}
      {#if !composerAvailable}<div class="pi-chat-disabled-notice">
          {composerDisabledReason}
        </div>{/if}
      <textarea
        id="pi-chat-message"
        name="message"
        rows="1"
        placeholder={t('composer.placeholder')}
        disabled={!composerAvailable}
      ></textarea>
      <div id="pi-chat-attachments" class="pi-chat-attachments"></div>
      <ChatSelectorPopups
        showModels={capabilities.modelListing && capabilities.modelSwitching}
        showThinking={capabilities.effortSelection || capabilities.reasoningSelection}
        showCommands={capabilities.slashCommands}
        showFiles={capabilities.files}
      />
      <ChatToolbar
        chatAvailable={composerAvailable}
        {toolbar}
        {modelLabel}
        {capabilities}
        {queueStore}
      />
      <ContextUsage popover={true} />
    </div>
    {#if pinnedTabs && currentSession}
      <PinnedChips
        model={pinnedTabs}
        {currentSession}
        {currentRunning}
        {currentWaiting}
        canCreate={capabilities.create}
        {onArchiveChange}
      />
    {/if}
    <TextAttachmentModal />
    <GitFooter {sessionId} />
  </form>
{/if}
