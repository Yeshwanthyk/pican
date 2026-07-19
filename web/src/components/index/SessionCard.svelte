<script lang="ts">
  import { t } from '../../shared/strings.js';
  import { handleNavClick } from '../../shared/navigation.js';
  import { prefetchSession } from '../../routes/session-prefetch.js';
  import { icon, Pin, PinOff } from '../../shared/icons.js';
  import { showToast } from '../../shared/toast.js';
  import {
    defaultUpdatePin,
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
  const runningModel = $derived(running ? formatRunningModel(runningStatus) : '');
  const search = $derived(sessionSearchText(session));
  const metrics = $derived(formatSessionMetrics(session));
  const runtime = $derived(session.runtime || 'pi');
  const pinLabel = $derived(session.pinned ? t('index.unpinSession') : t('index.pinSession'));

  let pinBusy = $state(false);

  // Start /api/session as soon as the user signals intent (hover or press), so
  // the response is usually back by the time SessionPage mounts. All three
  // events route through prefetchSession, which dedupes on session id.
  function startPrefetch() {
    if (session?.id) prefetchSession(session.id);
  }

  // Optimistic pin toggle: flip local state immediately (the session object is
  // shared with the page's reactive session list, so this alone moves the card
  // between the Pinned section and its normal group), then persist. On failure
  // revert and let the user know via toast.
  async function togglePin(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (pinBusy || !session?.id) return;
    const next = !session.pinned;
    session.pinned = next;
    pinBusy = true;
    try {
      await defaultUpdatePin(session.id, next);
    } catch (error: unknown) {
      session.pinned = !next;
      showToast(error instanceof Error ? error.message : t('index.networkError'));
    } finally {
      pinBusy = false;
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<a
  class="session-card"
  class:session-card--running={running}
  {href}
  onclick={(event) => handleNavClick(event, href)}
  onpointerenter={startPrefetch}
  onmousedown={startPrefetch}
  ontouchstart={startPrefetch}
  data-id={session.id}
  data-session-id={session.id}
  data-search={search}
>
  <div class="session-title-row">
    <div class="session-title">{title}</div>
    <div class="session-card-flags">
      {#if runtime === 'codex'}
        <span class="session-card-badge session-card-runtime" title={t('index.runtimeBadgeTitle')}>
          <img class="session-card-runtime-mark" src="/codex-icon.svg" alt="" aria-hidden="true" />
          {t('runtime.codex')}
        </span>
      {/if}
      {#if !session.chatAvailable}
        <span
          class="session-card-badge"
          title={session.chatDisabledReason || t('composer.disabledNotice')}
          >{t('index.viewOnly')}</span
        >
      {/if}
      <button
        class="session-pin-btn"
        class:session-pin-btn--pinned={session.pinned}
        type="button"
        aria-label={pinLabel}
        aria-pressed={!!session.pinned}
        title={pinLabel}
        disabled={pinBusy}
        onclick={togglePin}
      >
        {@html icon(session.pinned ? PinOff : Pin, { size: 14 })}
      </button>
    </div>
  </div>
  <div class="session-project">{session.project}</div>
  {#if modelLabel}
    <div class="session-model-row">
      {#if runtime === 'pi'}
        <img class="session-card-mark" src="/pi-icon.svg" alt="" aria-hidden="true" />
      {/if}
      <div class="session-model" data-session-model>{modelLabel}</div>
    </div>
  {/if}
  <div class="session-meta">
    <span class="session-active-status" data-running-status
      ><span aria-hidden="true">●</span> {t('index.active')}</span
    >
    <span class="session-time" data-timestamp={session.lastActivity} title={session.lastActivity}
      >{formatRelativeTime(session.lastActivity, now)}</span
    >
    <span class="session-run-model" data-running-model>{runningModel}</span>
  </div>
  {#if metrics}
    <div class="session-card-metrics">{metrics}</div>
  {/if}
</a>
