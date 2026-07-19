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

  let {
    sessionId = '',
    chatAvailable = true,
    chatDisabledReason = '',
    cwd = '',
    modelLabel = '',
  }: {
    sessionId?: string;
    chatAvailable?: boolean;
    chatDisabledReason?: string;
    cwd?: string;
    modelLabel?: string;
  } = $props();

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
  const isExtensionRequest = Schema.is(ExtensionRequestSchema);

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
      ? createQueueApi({
          sessionId,
          fetchImpl: typeof window !== 'undefined' ? window.fetch.bind(window) : undefined,
        })
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
    const target = window;
    const runtime = getSessionRuntime();
    const model = isUnknownRecord(runtime.model) ? runtime.model : null;
    const entries: SessionEntry[] = Array.isArray(model?.entries)
      ? model.entries.flatMap((entry) => {
          const parsed = sessionEntryFromUnknown(entry);
          return parsed ? [parsed] : [];
        })
      : [];
    const testHook = Reflect.get(globalThis, '__PI_TEST_CHAT_COMPOSER_HOOK__');
    if (typeof testHook === 'function') testHook();
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
      getLiveEntries: () => entries,
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
    });

    // Initial hydration from the server-side queue + subscribe to SSE 'queue'
    // events so changes from the autonomous drainer (or another tab) show up
    // immediately. The EventSource is shared with <LiveReload> — both attach
    // their own listeners.
    void queueStore.refresh?.();
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
    target.addEventListener('pi-queue-event', onQueueEvent);
    target.addEventListener('pi-extension-ui-request', onExtensionRequest);
    target.addEventListener('pi-extension-ui-resolved', onExtensionResolved);
    target.addEventListener('pi-extension-notify', onExtensionNotify);
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
    return () => {
      composerRuntime?.dispose?.();
      target.removeEventListener('pi-queue-event', onQueueEvent);
      target.removeEventListener('pi-extension-ui-request', onExtensionRequest);
      target.removeEventListener('pi-extension-ui-resolved', onExtensionResolved);
      target.removeEventListener('pi-extension-notify', onExtensionNotify);
    };
  });
</script>

<form
  id="pi-chat-composer"
  class="pi-chat-composer"
  data-session-id={sessionId}
  data-chat-available={chatAvailable}
  data-chat-disabled-reason={chatDisabledReason}
>
  <input
    id="pi-chat-images"
    name="images"
    type="file"
    accept="image/*"
    multiple
    hidden
    disabled={!chatAvailable}
  />
  {#if pendingExtensionUI.length > 0}
    <div class="extension-ui-stack">
      {#each pendingExtensionUI as request (request.id)}
        <ExtensionUiCard {request} {sessionId} onResolved={resolveExtensionUI} />
      {/each}
    </div>
  {/if}
  <QueuePanel store={queueStore} />
  <div class="pi-chat-shell composer-collapsed">
    <ChatExpandButton {chatAvailable} />
    {#if cwd}<div class="pi-chat-toolbar pi-chat-cwd-bar">
        <span class="pi-chat-cwd" title={t('composer.copyPath')} data-cwd={cwd}>cwd: {cwd}</span
        ><span class="pi-chat-focus-shortcut">{t('composer.focusShortcut')}</span>
      </div>{/if}
    {#if !chatAvailable}<div class="pi-chat-disabled-notice">{chatDisabledReason}</div>{/if}
    <textarea
      id="pi-chat-message"
      name="message"
      rows="1"
      placeholder={t('composer.placeholder')}
      disabled={!chatAvailable}
    ></textarea>
    <div id="pi-chat-attachments" class="pi-chat-attachments"></div>
    <ChatSelectorPopups />
    <ChatToolbar {chatAvailable} {toolbar} {modelLabel} />
    <ContextUsage popover={true} />
  </div>
  <TextAttachmentModal />
  <GitFooter {sessionId} />
</form>
