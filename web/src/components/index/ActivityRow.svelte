<script lang="ts">
  import { handleNavClick } from '../../shared/navigation.js';
  import { prefetchSession } from '../../routes/session-prefetch.js';
  import {
    icon,
    Clock,
    MoreHorizontal,
    Pin,
    PinOff,
    Terminal,
    TextQuote,
  } from '../../shared/icons.js';
  import { runtimeDisplay } from '../../lib/runtime-display';
  import { withBasePath } from '../../shared/base-path';
  import { t } from '../../shared/strings.js';
  import {
    formatElapsed,
    formatRelativeTime,
    formatRunningModel,
    sessionModelLabel,
    sessionSearchText,
    type NormalizedSession,
    type RunningStatus,
  } from '../../index/sessions.js';

  interface Props {
    session: NormalizedSession;
    running?: boolean;
    runningStatus?: RunningStatus | null;
    now?: number;
    archived?: boolean;
    pinBusy?: boolean;
    archiveBusy?: boolean;
    archiveDisabledReason?: string;
    archiveIcon: string;
    pinLabel: string;
    archiveLabel: string;
    onTogglePin: (event: MouseEvent) => void | Promise<void>;
    onToggleArchive: (event: MouseEvent) => void | Promise<void>;
  }

  let {
    session,
    running = false,
    runningStatus = null,
    now = Date.now(),
    archived = false,
    pinBusy = false,
    archiveBusy = false,
    archiveDisabledReason = '',
    archiveIcon,
    pinLabel,
    archiveLabel,
    onTogglePin,
    onToggleArchive,
  }: Props = $props();

  const href = $derived(withBasePath(`/session?id=${encodeURIComponent(session.id || '')}`));
  const title = $derived(session.name || session.id || '');
  const modelLabel = $derived(formatRunningModel(runningStatus) || sessionModelLabel(session));
  const runtimeMark = $derived(runtimeDisplay(session.runtime));
  const search = $derived(sessionSearchText(session));
  const waiting = $derived(Boolean(session.waitingQuestion));
  const active = $derived(running || waiting);
  const statusElapsed = $derived(
    formatElapsed(
      waiting
        ? session.waitingSince || session.activityStartedAt || session.lastActivity
        : session.activityStartedAt || session.lastActivity,
      now,
    ),
  );
  const statusText = $derived(
    waiting
      ? t('index.waitingStatus', {
          elapsed: statusElapsed,
          question: session.waitingQuestion,
        })
      : running
        ? t('index.runningStatus', {
            activity: session.currentActivity || t('index.working'),
            elapsed: statusElapsed,
          })
        : t('index.idle'),
  );

  let mobileMenuOpen = $state(false);
  let mobileActions = $state<HTMLDivElement | null>(null);
  const mobileMenuId = $derived(
    `session-actions-${(session.id || 'session').replace(/[^a-zA-Z0-9_-]/g, '-')}`,
  );

  $effect(() => {
    if (!mobileMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (mobileActions?.contains(event.target as Node)) return;
      mobileMenuOpen = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  });

  function startPrefetch() {
    if (session.id) prefetchSession(session.id);
  }

  function togglePin(event: MouseEvent) {
    mobileMenuOpen = false;
    return onTogglePin(event);
  }

  function toggleArchive(event: MouseEvent) {
    mobileMenuOpen = false;
    return onToggleArchive(event);
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<article
  class="activity-row session-ticker-row"
  class:activity-row--running={running && !waiting}
  class:activity-row--waiting={waiting}
  class:session-ticker-row--running={running && !waiting}
  class:session-ticker-row--waiting={waiting}
  data-id={session.id}
  data-session-id={session.id}
  data-search={search}
  data-activity-state={waiting ? 'waiting' : running ? 'running' : 'idle'}
>
  <a
    class="activity-row-link session-ticker-link"
    {href}
    onclick={(event) => handleNavClick(event, href)}
    onpointerenter={startPrefetch}
    onmousedown={startPrefetch}
    ontouchstart={startPrefetch}
  >
    <span class="activity-row-icon" class:activity-row-icon--active={active} aria-hidden="true">
      {#if waiting}
        {@html icon(Clock, { size: 16, strokeWidth: 1.5 })}
      {:else if running}
        {@html icon(Terminal, { size: 16, strokeWidth: 1.5 })}
      {:else if runtimeMark.icon}
        <img src={runtimeMark.icon} alt="" />
      {:else}
        <span title={runtimeMark.label}>{runtimeMark.initial}</span>
      {/if}
    </span>
    <span class="activity-row-copy">
      <span class="activity-row-title-line session-ticker-title-line">
        <span class="activity-row-title session-ticker-title">{title}</span>
        {#if session.pinned}
          <span class="activity-row-marker" title={t('index.pinned')} aria-hidden="true">
            {@html icon(Pin, { size: 12, strokeWidth: 1.5 })}
          </span>
        {/if}
        {#if session.btw}
          <span class="activity-row-marker" aria-hidden="true">
            {@html icon(TextQuote, { size: 12, strokeWidth: 1.5 })}
          </span>
        {/if}
        {#if !session.chatAvailable}
          <span class="session-ticker-view-only">{t('index.viewOnly')}</span>
        {/if}
      </span>
      <span class="activity-row-meta" data-active-metadata={active ? '' : undefined}>
        <span
          class:activity-row-status--running={running && !waiting}
          class:activity-row-status--waiting={waiting}
        >
          {statusText}
        </span>
        {#if session.project}<span>{session.project}</span>{/if}
        <span title={modelLabel || runtimeMark.label}>{runtimeMark.label}</span>
        <span data-timestamp={session.lastActivity} title={session.lastActivity}>
          {formatRelativeTime(session.lastActivity, now)}
        </span>
      </span>
    </span>
  </a>
  <button
    class="session-ticker-pin session-ticker-action--desktop"
    type="button"
    aria-label={archiveLabel}
    title={archiveDisabledReason || archiveLabel}
    disabled={archiveBusy || Boolean(archiveDisabledReason)}
    style:right="44px"
    onclick={toggleArchive}
  >
    {@html archiveIcon}
  </button>
  <button
    class="session-ticker-pin session-ticker-action--desktop"
    class:session-ticker-pin--pinned={session.pinned}
    type="button"
    aria-label={pinLabel}
    aria-pressed={session.pinned}
    title={pinLabel}
    disabled={pinBusy}
    onclick={togglePin}
  >
    {@html icon(session.pinned ? PinOff : Pin, { size: 14 })}
  </button>
  <div
    bind:this={mobileActions}
    class="session-ticker-mobile-actions"
    class:session-ticker-mobile-actions--open={mobileMenuOpen}
  >
    <button
      class="session-ticker-more"
      type="button"
      aria-label={t('index.moreSessionActions')}
      aria-haspopup="menu"
      aria-expanded={mobileMenuOpen}
      aria-controls={mobileMenuId}
      onclick={() => {
        mobileMenuOpen = !mobileMenuOpen;
      }}
    >
      {@html icon(MoreHorizontal, { size: 17 })}
    </button>
    {#if mobileMenuOpen}
      <div id={mobileMenuId} class="session-ticker-action-menu" role="menu">
        <button type="button" role="menuitem" disabled={pinBusy} onclick={togglePin}>
          <span>{@html icon(session.pinned ? PinOff : Pin, { size: 15 })}</span>
          <span>{pinLabel}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          title={archiveDisabledReason || archiveLabel}
          disabled={archiveBusy || Boolean(archiveDisabledReason)}
          onclick={toggleArchive}
        >
          <span>{@html archiveIcon}</span>
          <span>{archiveLabel}</span>
          {#if archiveDisabledReason}
            <span class="session-ticker-action-reason">{archiveDisabledReason}</span>
          {/if}
        </button>
      </div>
    {/if}
  </div>
</article>
