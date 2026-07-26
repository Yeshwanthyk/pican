<script lang="ts">
  import { runtimeDisplay } from '../../lib/runtime-display';
  import { handleNavClick } from '../../shared/navigation';
  import { icon, Pin, PinOff, Plus } from '../../shared/icons';
  import { t } from '../../shared/strings';
  import { showToast } from '../../shared/toast';
  import { prefetchSession } from '../../routes/session-prefetch';
  import { withBasePath } from '../../shared/base-path';
  import type { NormalizedSession } from '../../index/sessions';
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

  const currentPinned = $derived(model.isPinned(currentSession.id));
  const visiblePinned = $derived(
    selectVisiblePinnedSessions(model.sessions, currentSession.id, currentPinned ? 8 : 7),
  );

  function hrefFor(sessionId: string): string {
    return withBasePath(`/session?id=${encodeURIComponent(sessionId)}`);
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

  async function setPinned(session: NormalizedSession, pinned: boolean): Promise<void> {
    if (await model.setPinned(session, pinned)) {
      if (pinned && session.id === currentSession.id && session.archived) onArchiveChange?.(false);
      return;
    }
    showToast(t('session.pinnedUpdateFailed'));
  }

  function createSession(): void {
    document.getElementById('new-session-header-btn')?.click();
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<nav class="pinned-tabs-strip" aria-label={t('session.pinnedSessions')}>
  <div class="pinned-tabs-list" role="tablist">
    {#each visiblePinned as session (session.id)}
      {@const active = session.id === currentSession.id}
      {@const mark = runtimeDisplay(session.runtime)}
      {@const waiting = isWaiting(session)}
      {@const running = isRunning(session) && !waiting}
      {@const href = hrefFor(session.id)}
      <div
        class="pinned-tab"
        class:pinned-tab--active={active}
        class:pinned-tab--running={running}
        class:pinned-tab--waiting={waiting}
        data-session-id={session.id}
      >
        <a
          role="tab"
          aria-selected={active}
          aria-current={active ? 'page' : undefined}
          {href}
          onclick={(event) => handleNavClick(event, href)}
          onpointerenter={() => startPrefetch(session.id)}
          onmousedown={() => startPrefetch(session.id)}
          ontouchstart={() => startPrefetch(session.id)}
        >
          {#if mark.icon}
            <img class="pinned-tab-runtime" src={mark.icon} alt="" aria-hidden="true" />
          {:else}
            <span class="pinned-tab-runtime" aria-hidden="true" title={mark.label}
              >{mark.initial}</span
            >
          {/if}
          <span class="pinned-tab-status" aria-hidden="true"></span>
          <span class="pinned-tab-title">{session.name}</span>
        </a>
        <button
          type="button"
          class="pinned-tab-pin"
          disabled={model.isBusy(session.id)}
          aria-label={t('index.unpinSession')}
          title={t('index.unpinSession')}
          onclick={() => setPinned(session, false)}>{@html icon(PinOff, { size: 13 })}</button
        >
      </div>
    {/each}

    {#if !currentPinned}
      {@const mark = runtimeDisplay(currentSession.runtime)}
      <div
        class="pinned-tab pinned-tab--active pinned-tab--guest"
        class:pinned-tab--running={currentRunning && !currentWaiting}
        class:pinned-tab--waiting={currentWaiting}
        data-session-id={currentSession.id}
      >
        <a role="tab" aria-selected="true" aria-current="page" href={hrefFor(currentSession.id)}>
          {#if mark.icon}
            <img class="pinned-tab-runtime" src={mark.icon} alt="" aria-hidden="true" />
          {:else}
            <span class="pinned-tab-runtime" aria-hidden="true" title={mark.label}
              >{mark.initial}</span
            >
          {/if}
          <span class="pinned-tab-status" aria-hidden="true"></span>
          <span class="pinned-tab-title">{currentSession.name}</span>
        </a>
        <button
          type="button"
          class="pinned-tab-pin pinned-tab-pin--guest"
          disabled={model.isBusy(currentSession.id)}
          aria-label={t('index.pinSession')}
          title={t('index.pinSession')}
          onclick={() => setPinned(currentSession, true)}>{@html icon(Pin, { size: 13 })}</button
        >
      </div>
    {/if}
  </div>

  {#if canCreate}
    <button
      type="button"
      class="pinned-tabs-new"
      aria-label={t('session.newSession')}
      title={t('session.newSession')}
      onclick={createSession}>{@html icon(Plus, { size: 15 })}</button
    >
  {/if}
</nav>
