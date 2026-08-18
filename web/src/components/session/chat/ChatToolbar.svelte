<script lang="ts">
  import { icon, Paperclip } from '../../../shared/icons.js';
  import { t } from '../../../shared/strings.js';
  import { ChatToolbarState } from './chat-toolbar-state.svelte.js';
  import ContextUsage from './ContextUsage.svelte';
  import {
    defaultRuntimeCapabilities,
    type CompleteRuntimeCapabilities,
  } from '../../../lib/runtime-capabilities.js';
  import type { QueueStore } from './queue-store.svelte.js';

  let {
    chatAvailable = true,
    toolbar = new ChatToolbarState(),
    modelLabel = '',
    capabilities = defaultRuntimeCapabilities('pi'),
    queueStore = null,
  }: {
    chatAvailable?: boolean;
    toolbar?: ChatToolbarState;
    modelLabel?: string;
    capabilities?: CompleteRuntimeCapabilities;
    queueStore?: QueueStore | null;
  } = $props();

  const statusText = $derived(
    toolbar.statusText || (chatAvailable ? t('composer.idle') : t('composer.unavailable')),
  );
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div class="pi-chat-toolbar">
  <div class="pi-chat-toolbar-left">
    {#if capabilities.images}<button
        type="button"
        id="pi-chat-attach"
        class="pi-chat-icon-button pi-chat-photo-button"
        title={t('composer.attachPhotos')}
        aria-label={t('composer.attachPhotos')}
        disabled={!chatAvailable}>{@html icon(Paperclip, { size: 15 })}</button
      >{/if}
    <span id="pi-chat-status" class="pi-chat-status {toolbar.statusClass}" aria-live="polite"
      >{statusText}</span
    >
    {#if capabilities.effortSelection || capabilities.reasoningSelection}<button
        type="button"
        id="pi-chat-thinking-label"
        class="pi-chat-thinking-label {toolbar.thinkingLevel
          ? 'thinking-' + toolbar.thinkingLevel
          : ''}"
        style:display={toolbar.thinkingLevel ? '' : 'none'}
        title={t('composer.switchEffort')}
        disabled={!chatAvailable}>{toolbar.thinkingLevel}</button
      >{/if}
    {#if capabilities.modelListing && capabilities.modelSwitching}<button
        type="button"
        id="pi-chat-model-label"
        class="pi-chat-model-label"
        title={t('composer.switchModel')}
        style:display={chatAvailable ? '' : 'none'}
        disabled={!chatAvailable}
        >{toolbar.modelLabel || modelLabel || t('composer.modelPlaceholder')}</button
      >{/if}
    <ContextUsage />
  </div>
  <div
    class="actions pi-chat-actions"
    class:pi-chat-actions--running={toolbar.isRunning}
    aria-label={toolbar.isRunning ? t('composer.runningActions') : t('composer.idleActions')}
  >
    {#if capabilities.cancel}<button
        type="button"
        id="pi-chat-cancel"
        class="pi-chat-cancel pi-chat-stop"
        style:display={toolbar.isRunning ? '' : 'none'}
        title={t('composer.stopRunning')}
        aria-label={t('composer.stopRunning')}
        disabled={toolbar.statusText === 'stopping' || !chatAvailable}>{t('composer.stop')}</button
      >{/if}
    <div class="pi-chat-route-actions">
      <button
        type="submit"
        id="pi-chat-send"
        class="pi-chat-send"
        style:display={toolbar.isRunning && !capabilities.steer ? 'none' : ''}
        title={toolbar.isRunning ? t('composer.steerHint') : t('composer.sendHint')}
        disabled>{toolbar.isRunning ? t('composer.steerNow') : t('composer.send')}</button
      >
      {#if capabilities.persistentQueue}<button
          type="button"
          id="pi-chat-queue"
          class="pi-chat-queue"
          class:pi-chat-queue--paused={queueStore?.paused}
          style:display={toolbar.isRunning || (queueStore?.count ?? 0) > 0 || queueStore?.paused
            ? ''
            : 'none'}
          title={queueStore?.paused ? t('composer.queuePausedBadge') : t('composer.queueHint')}
          disabled
          >{t('composer.queueNext')}
          {#if queueStore?.paused}<span
              class="pi-chat-queue-paused"
              role="img"
              aria-label={t('composer.queuePausedBadge')}
            ></span>{/if}
          {#if (queueStore?.queuedCount ?? 0) > 0}<span
              class="pi-chat-queue-badge"
              aria-label={t('composer.queueBadgeCount', { count: queueStore?.queuedCount })}
              >{queueStore?.queuedCount}</span
            >{/if}
        </button>{/if}
    </div>
  </div>
</div>
