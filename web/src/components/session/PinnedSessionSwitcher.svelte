<script lang="ts">
  import { icon, Check, Pin, PinOff, Search, X } from '../../shared/icons';
  import { navigate } from '../../shared/navigation';
  import { openSessionPalette } from '../../shared/command-palette-runtime';
  import { t } from '../../shared/strings';
  import { runtimeDisplay } from '../../lib/runtime-display';
  import type { NormalizedSession } from '../../index/sessions';
  import type { PinnedTabsModel } from '../../session/pinned-tabs-model.svelte';

  let {
    model,
    currentSession,
    onArchiveChange = null,
  }: {
    model: PinnedTabsModel;
    currentSession: NormalizedSession;
    onArchiveChange?: ((archived: boolean) => void) | null;
  } = $props();

  let popover = $state<HTMLElement | null>(null);
  let error = $state('');

  const currentPinned = $derived(model.isPinned(currentSession.id));
  const pinBusy = $derived(model.isBusy(currentSession.id));

  function close(): void {
    if (popover && typeof popover.hidePopover === 'function') popover.hidePopover();
  }

  async function loadPinnedSessions(): Promise<void> {
    error = '';
    if (!(await model.load())) error = t('session.pinnedLoadFailed');
  }

  function handleToggle(event: Event): void {
    if ((event as ToggleEvent).newState === 'open') void loadPinnedSessions();
  }

  function openSession(id: string): void {
    close();
    if (id !== currentSession.id) navigate('/session?id=' + encodeURIComponent(id));
  }

  async function toggleCurrentPin(): Promise<void> {
    if (!currentSession.id || pinBusy) return;
    error = '';
    const next = !currentPinned;
    if (await model.setPinned(currentSession, next)) {
      if (next && currentSession.archived) onArchiveChange?.(false);
    } else {
      error = t('session.pinnedUpdateFailed');
    }
  }

  function searchSessions(): void {
    close();
    setTimeout(() => openSessionPalette(), 0);
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<div
  id="pinned-session-switcher"
  class="pinned-session-switcher"
  popover="auto"
  aria-label={t('session.pinnedSessions')}
  bind:this={popover}
  ontoggle={handleToggle}
>
  <div class="pinned-session-switcher-head">
    <span>{t('session.pinnedSessions')}</span>
    <button
      type="button"
      class="pinned-session-switcher-close"
      aria-label={t('common.close')}
      onclick={close}>{@html icon(X, { size: 15 })}</button
    >
  </div>

  <div class="pinned-session-switcher-list" aria-live="polite">
    {#if model.loading}
      <div class="pinned-session-switcher-state">{t('session.loadingPinnedSessions')}</div>
    {:else if error}
      <button
        type="button"
        class="pinned-session-switcher-state pinned-session-switcher-retry"
        onclick={loadPinnedSessions}>{error} · {t('common.retry')}</button
      >
    {:else if model.sessions.length === 0}
      <div class="pinned-session-switcher-state">{t('session.noPinnedSessions')}</div>
    {:else}
      {#each model.sessions as session (session.id)}
        {@const mark = runtimeDisplay(session.runtime)}
        <button
          type="button"
          class="pinned-session-switcher-row"
          class:pinned-session-switcher-row--current={session.id === currentSession.id}
          aria-current={session.id === currentSession.id ? 'page' : undefined}
          onclick={() => openSession(session.id)}
        >
          {#if mark.icon}
            <img
              class="pinned-session-switcher-runtime-mark"
              src={mark.icon}
              alt=""
              aria-hidden="true"
              title={mark.label}
            />
          {:else}
            <span class="pinned-session-switcher-runtime-mark" aria-hidden="true" title={mark.label}
              >{mark.initial}</span
            >
          {/if}
          <span class="pinned-session-switcher-copy">
            <span class="pinned-session-switcher-title">{session.name}</span>
            <span class="pinned-session-switcher-project">{session.project}</span>
          </span>
          {#if session.id === currentSession.id}
            <span class="pinned-session-switcher-check" aria-hidden="true"
              >{@html icon(Check, { size: 15 })}</span
            >
          {/if}
        </button>
      {/each}
    {/if}
  </div>

  <div class="pinned-session-switcher-actions">
    <button type="button" disabled={pinBusy} onclick={toggleCurrentPin}>
      <span aria-hidden="true">{@html icon(currentPinned ? PinOff : Pin, { size: 14 })}</span>
      {currentPinned ? t('session.unpinCurrent') : t('session.pinCurrent')}
    </button>
    <button type="button" onclick={searchSessions}>
      <span aria-hidden="true">{@html icon(Search, { size: 14 })}</span>
      {t('index.searchSessions')}
    </button>
  </div>
</div>
