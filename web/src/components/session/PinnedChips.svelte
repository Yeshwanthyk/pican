<script lang="ts">
  import { onMount } from 'svelte';
  import { formatRelativeTime, type NormalizedSession } from '../../index/sessions';
  import { runtimeDisplay } from '../../lib/runtime-display';
  import { handleNavClick } from '../../shared/navigation';
  import { icon, Pin, PinOff, Plus } from '../../shared/icons';
  import { t } from '../../shared/strings';
  import { showToast } from '../../shared/toast';
  import { prefetchSession } from '../../routes/session-prefetch';
  import {
    selectVisiblePinnedSessions,
    type PinnedTabsModel,
  } from '../../session/pinned-tabs-model.svelte';

  let {
    model,
    currentSession,
    currentRunning = false,
    currentWaiting = false,
    canCreate = false,
    onArchiveChange = null,
  }: {
    model: PinnedTabsModel;
    currentSession: NormalizedSession;
    currentRunning?: boolean;
    currentWaiting?: boolean;
    canCreate?: boolean;
    onArchiveChange?: ((archived: boolean) => void) | null;
  } = $props();

  let row = $state<HTMLElement | null>(null);
  let idleCapacity = $state(0);

  const currentPinned = $derived(model.isPinned(currentSession.id));
  const visiblePinned = $derived(
    currentPinned
      ? selectVisiblePinnedSessions(model.sessions, currentSession.id, idleCapacity + 1)
      : model.sessions.slice(0, idleCapacity),
  );

  function updateCapacity(width: number): void {
    idleCapacity = Math.max(0, Math.floor((width - 136 - (canCreate ? 45 : 0)) / 45));
  }

  onMount(() => {
    if (!row) return;
    updateCapacity(row.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number') updateCapacity(width);
    });
    observer.observe(row);
    return () => observer.disconnect();
  });

  function hrefFor(sessionId: string): string {
    return `/session?id=${encodeURIComponent(sessionId)}`;
  }

  function startPrefetch(sessionId: string): void {
    prefetchSession(sessionId);
  }

  function isRunning(session: NormalizedSession): boolean {
    return session.id === currentSession.id ? currentRunning : model.isRunning(session.id);
  }

  function isWaiting(session: NormalizedSession): boolean {
    return session.id === currentSession.id ? currentWaiting : Boolean(session.waitingQuestion);
  }

  function captionFor(session: NormalizedSession): string {
    if (isWaiting(session)) return t('session.tabsAwaiting');
    if (isRunning(session)) return session.currentActivity || t('index.working');
    const age = formatRelativeTime(session.lastActivity);
    return age ? t('session.tabsIdleAge', { age }) : t('session.tabsIdle');
  }

  async function setCurrentPinned(pinned: boolean): Promise<void> {
    if (await model.setPinned(currentSession, pinned)) {
      if (pinned && currentSession.archived) onArchiveChange?.(false);
      return;
    }
    showToast(t('session.pinnedUpdateFailed'));
  }

  function createSession(): void {
    document.getElementById('new-session-header-btn')?.click();
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<nav
  class="pinned-chips"
  aria-label={t('session.pinnedSessions')}
  bind:this={row}
  data-idle-capacity={idleCapacity}
>
  {#each visiblePinned as session (session.id)}
    {@const active = session.id === currentSession.id}
    {@const waiting = isWaiting(session)}
    {@const running = isRunning(session) && !waiting}
    {@const mark = runtimeDisplay(session.runtime)}
    {@const href = hrefFor(session.id)}
    <div
      class="pinned-chip"
      class:pinned-chip--active={active}
      class:pinned-chip--running={running}
      class:pinned-chip--waiting={waiting}
      data-session-id={session.id}
    >
      <a
        {href}
        aria-current={active ? 'page' : undefined}
        aria-label={`${session.name} · ${captionFor(session)}`}
        onclick={(event) => handleNavClick(event, href)}
        onpointerenter={() => startPrefetch(session.id)}
        onmousedown={() => startPrefetch(session.id)}
        ontouchstart={() => startPrefetch(session.id)}
      >
        {#if mark.icon}
          <img class="pinned-chip-runtime" src={mark.icon} alt="" aria-hidden="true" />
        {:else}
          <span class="pinned-chip-runtime" aria-hidden="true" title={mark.label}
            >{mark.initial}</span
          >
        {/if}
        <span class="pinned-chip-status" aria-hidden="true"></span>
        {#if active}
          <span class="pinned-chip-copy">
            <span class="pinned-chip-title">{session.name}</span>
            <span class="pinned-chip-caption">{captionFor(session)}</span>
          </span>
        {/if}
      </a>
      {#if active}
        <button
          type="button"
          class="pinned-chip-pin"
          disabled={model.isBusy(currentSession.id)}
          aria-label={t('index.unpinSession')}
          title={t('index.unpinSession')}
          onclick={() => setCurrentPinned(false)}>{@html icon(PinOff, { size: 14 })}</button
        >
      {/if}
    </div>
  {/each}

  {#if !currentPinned}
    {@const mark = runtimeDisplay(currentSession.runtime)}
    <div
      class="pinned-chip pinned-chip--active pinned-chip--guest"
      class:pinned-chip--running={currentRunning && !currentWaiting}
      class:pinned-chip--waiting={currentWaiting}
      data-session-id={currentSession.id}
    >
      <a
        href={hrefFor(currentSession.id)}
        aria-current="page"
        aria-label={`${currentSession.name} · ${captionFor(currentSession)}`}
      >
        {#if mark.icon}
          <img class="pinned-chip-runtime" src={mark.icon} alt="" aria-hidden="true" />
        {:else}
          <span class="pinned-chip-runtime" aria-hidden="true" title={mark.label}
            >{mark.initial}</span
          >
        {/if}
        <span class="pinned-chip-status" aria-hidden="true"></span>
        <span class="pinned-chip-copy">
          <span class="pinned-chip-title">{currentSession.name}</span>
          <span class="pinned-chip-caption">{captionFor(currentSession)}</span>
        </span>
      </a>
      <button
        type="button"
        class="pinned-chip-pin"
        disabled={model.isBusy(currentSession.id)}
        aria-label={t('index.pinSession')}
        title={t('index.pinSession')}
        onclick={() => setCurrentPinned(true)}>{@html icon(Pin, { size: 14 })}</button
      >
    </div>
  {/if}

  {#if canCreate}
    <button
      type="button"
      class="pinned-chips-new"
      aria-label={t('session.newSession')}
      title={t('session.newSession')}
      onclick={createSession}>{@html icon(Plus, { size: 16 })}</button
    >
  {/if}
</nav>
