<script lang="ts">
  import { runPromise } from '../../lib/runtime';
  import { effects } from '../../shared/api';
  import { icon, Check, Pin, PinOff, Search, X } from '../../shared/icons';
  import { navigate } from '../../shared/navigation';
  import { openSessionPalette } from '../../shared/command-palette-runtime';
  import { t } from '../../shared/strings';
  import { normalizeSession, type NormalizedSession } from '../../index/sessions';
  import { settle } from '../shared/ui-effect';

  let { sessionId = '' }: { sessionId?: string } = $props();

  let popover = $state<HTMLElement | null>(null);
  let sessions = $state<NormalizedSession[]>([]);
  let loading = $state(false);
  let error = $state('');
  let pinBusy = $state(false);

  const currentPinned = $derived(sessions.some((session) => session.id === sessionId));

  function close(): void {
    if (popover && typeof popover.hidePopover === 'function') popover.hidePopover();
  }

  async function loadPinnedSessions(): Promise<void> {
    loading = true;
    error = '';
    const result = await settle(() =>
      Promise.all([
        runPromise(effects.sessions.pins),
        runPromise(effects.sessions.list({ limit: 1 })),
      ]),
    );
    if (result.ok) {
      const [pinResponse, sessionResponse] = result.value;
      const byId = new Map(
        sessionResponse.sessions.map((raw) => {
          const session = normalizeSession(raw);
          return [session.id, session] as const;
        }),
      );
      sessions = pinResponse.pins.flatMap((id) => {
        const session = byId.get(id);
        return session ? [session] : [];
      });
    } else {
      error = t('session.pinnedLoadFailed');
    }
    loading = false;
  }

  function handleToggle(event: Event): void {
    if ((event as ToggleEvent).newState === 'open') void loadPinnedSessions();
  }

  function openSession(id: string): void {
    close();
    if (id !== sessionId) navigate('/session?id=' + encodeURIComponent(id));
  }

  async function toggleCurrentPin(): Promise<void> {
    if (!sessionId || pinBusy) return;
    pinBusy = true;
    const result = await settle(() =>
      runPromise(effects.sessions.updatePin(sessionId, !currentPinned)),
    );
    if (result.ok) await loadPinnedSessions();
    else error = t('session.pinnedUpdateFailed');
    pinBusy = false;
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
    {#if loading}
      <div class="pinned-session-switcher-state">{t('session.loadingPinnedSessions')}</div>
    {:else if error}
      <button
        type="button"
        class="pinned-session-switcher-state pinned-session-switcher-retry"
        onclick={loadPinnedSessions}>{error} · {t('common.retry')}</button
      >
    {:else if sessions.length === 0}
      <div class="pinned-session-switcher-state">{t('session.noPinnedSessions')}</div>
    {:else}
      {#each sessions as session (session.id)}
        <button
          type="button"
          class="pinned-session-switcher-row"
          class:pinned-session-switcher-row--current={session.id === sessionId}
          aria-current={session.id === sessionId ? 'page' : undefined}
          onclick={() => openSession(session.id)}
        >
          <span class="pinned-session-switcher-copy">
            <span class="pinned-session-switcher-title">{session.name}</span>
            <span class="pinned-session-switcher-project">{session.project}</span>
          </span>
          {#if session.id === sessionId}
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
