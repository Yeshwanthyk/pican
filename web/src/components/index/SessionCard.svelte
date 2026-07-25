<script lang="ts">
  import { t } from '../../shared/strings.js';
  import { handleNavClick } from '../../shared/navigation.js';
  import { prefetchSession } from '../../routes/session-prefetch.js';
  import { icon, MoreHorizontal, Pin, PinOff } from '../../shared/icons.js';
  import { showToast } from '../../shared/toast.js';
  import { describeError } from '../../lib/errors';
  import { runtimeDisplay } from '../../lib/runtime-display';
  import { Archive, ArchiveRestore } from 'lucide';
  import { settle } from '../shared/ui-effect';
  import {
    defaultUpdateArchive,
    defaultUpdatePin,
    formatElapsed,
    formatRelativeTime,
    formatRunningModel,
    formatSessionMetrics,
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
  }

  let { session, running = false, runningStatus = null, now = Date.now() }: Props = $props();

  const href = $derived(`/session?id=${encodeURIComponent(session.id || '')}`);
  const title = $derived(session.name || session.id || '');
  const modelLabel = $derived(formatRunningModel(runningStatus) || sessionModelLabel(session));
  const runtimeMark = $derived(runtimeDisplay(session.runtime));
  const search = $derived(sessionSearchText(session));
  const metrics = $derived(formatSessionMetrics(session));
  const waiting = $derived(Boolean(session.waitingQuestion));
  let archived = $state(false);
  $effect(() => {
    archived = session.archived;
  });
  const statusElapsed = $derived(
    formatElapsed(
      waiting
        ? session.waitingSince || session.activityStartedAt || session.lastActivity
        : session.activityStartedAt || session.lastActivity,
      now,
    ),
  );
  const pinLabel = $derived(session.pinned ? t('index.unpinSession') : t('index.pinSession'));
  const archiveLabel = $derived(archived ? t('index.restoreSession') : t('index.archiveSession'));
  const archiveDisabledReason = $derived(
    archived
      ? ''
      : waiting
        ? t('index.archiveDisabledWaiting')
        : running
          ? t('index.archiveDisabledRunning')
          : '',
  );

  let pinBusy = $state(false);
  let archiveBusy = $state(false);
  let mobileMenuOpen = $state(false);
  const mobileMenuId = $derived(
    `session-actions-${(session.id || 'session').replace(/[^a-zA-Z0-9_-]/g, '-')}`,
  );

  $effect(() => {
    if (!mobileMenuOpen) return;
    const close = () => {
      mobileMenuOpen = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  });

  function startPrefetch() {
    if (session.id) prefetchSession(session.id);
  }

  async function togglePin(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (pinBusy || !session.id) return;
    const next = !session.pinned;
    session.pinned = next;
    pinBusy = true;
    const result = await settle(() => defaultUpdatePin(session.id, next));
    if (!result.ok) {
      session.pinned = !next;
      showToast(describeError(result.error.cause) || t('index.networkError'));
    }
    pinBusy = false;
    mobileMenuOpen = false;
  }

  async function toggleArchive(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (archiveBusy || archiveDisabledReason || !session.id) return;
    const next = !archived;
    archived = next;
    session.archived = next;
    archiveBusy = true;
    const result = await settle(() => defaultUpdateArchive(session.id, next));
    if (!result.ok) {
      archived = !next;
      session.archived = !next;
      showToast(describeError(result.error.cause) || t('index.archiveUpdateFailed'));
    }
    archiveBusy = false;
    mobileMenuOpen = false;
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<div
  class="session-ticker-row"
  class:session-ticker-row--running={running && !waiting}
  class:session-ticker-row--waiting={waiting}
  data-id={session.id}
  data-session-id={session.id}
  data-search={search}
>
  <a
    class="session-ticker-link"
    {href}
    onclick={(event) => handleNavClick(event, href)}
    onpointerenter={startPrefetch}
    onmousedown={startPrefetch}
    ontouchstart={startPrefetch}
  >
    <div class="session-ticker-title-line">
      {#if runtimeMark.icon}
        <img
          class="session-ticker-runtime-mark"
          src={runtimeMark.icon}
          alt=""
          aria-hidden="true"
          title={runtimeMark.label}
        />
      {:else}
        <span class="session-ticker-runtime-mark" aria-hidden="true" title={runtimeMark.label}
          >{runtimeMark.initial}</span
        >
      {/if}
      <span class="session-ticker-markers" aria-hidden="true">
        {#if session.pinned}<span>⌖</span>{/if}
        {#if session.btw}<span>~</span>{/if}
      </span>
      <span class="session-ticker-title">{title}</span>
      {#if !session.chatAvailable}<span class="session-ticker-view-only">{t('index.viewOnly')}</span
        >{/if}
    </div>
    {#if waiting}
      <div class="session-ticker-status session-ticker-status--waiting">
        <span class="session-ticker-dot" aria-hidden="true"></span>
        <span
          >{t('index.waitingStatus', {
            elapsed: statusElapsed,
            question: session.waitingQuestion,
          })}</span
        >
      </div>
    {:else if running}
      <div class="session-ticker-status session-ticker-status--running">
        <span class="session-ticker-dot session-ticker-dot--pulse" aria-hidden="true"></span>
        <span
          >{t('index.runningStatus', {
            activity: session.currentActivity || t('index.working'),
            elapsed: statusElapsed,
          })}</span
        >
      </div>
    {/if}
    <div class="session-ticker-foot">
      <span class="session-ticker-context">
        <span>{session.project}</span>
        {#if modelLabel}<span aria-hidden="true">·</span><span data-session-model>{modelLabel}</span
          >{/if}
      </span>
      <span class="session-ticker-metrics">
        {#if metrics}
          <span class="session-ticker-metric-values">{metrics}</span>
          <span class="session-ticker-metric-separator" aria-hidden="true">·</span>
        {/if}
        <span data-timestamp={session.lastActivity} title={session.lastActivity}
          >{formatRelativeTime(session.lastActivity, now)}</span
        >
      </span>
    </div>
  </a>
  <button
    class="session-ticker-pin session-ticker-action--desktop"
    type="button"
    aria-label={archiveLabel}
    title={archiveDisabledReason || archiveLabel}
    disabled={archiveBusy || Boolean(archiveDisabledReason)}
    style:right="40px"
    onclick={toggleArchive}
  >
    {@html icon(archived ? ArchiveRestore : Archive, { size: 14 })}
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
          <span>{@html icon(archived ? ArchiveRestore : Archive, { size: 15 })}</span>
          <span>{archiveLabel}</span>
          {#if archiveDisabledReason}
            <span class="session-ticker-action-reason">{archiveDisabledReason}</span>
          {/if}
        </button>
      </div>
    {/if}
  </div>
</div>
