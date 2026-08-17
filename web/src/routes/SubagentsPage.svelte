<script lang="ts">
  import { onMount } from 'svelte';
  import { formatRelativeTime } from '../index/sessions';
  import { handleNavClick, navigate } from '../shared/navigation';
  import { shortenPath } from '../session/render/session-format';
  import { createStatusEvents } from '../shared/status-events';
  import { icon, ChevronLeft, Check, X, Layers } from '../shared/icons';
  import { t } from '../shared/strings';
  import {
    defaultFetchSubagents,
    normalizeSubagent,
    orderSubagents,
    subagentActivityTime,
    subagentProject,
    subagentTranscriptHref,
  } from '../subagents/subagents';
  import type { Subagent } from '../subagents/subagents';
  import { describeError } from '../lib/errors';
  import { recoverSync, settle } from '../components/shared/ui-effect';
  import { withBasePath } from '../shared/base-path';

  let { session = '' }: { session?: string } = $props();

  let subagents = $state<ReadonlyArray<Subagent>>([]);
  let loading = $state(true);
  let loadError = $state('');
  let generation = 0;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;

  const counts = $derived.by(() => {
    const running = subagents.filter((s) => s.status === 'running').length;
    const done = subagents.filter((s) => s.status === 'done').length;
    const error = subagents.filter((s) => s.status === 'error').length;
    const unknown = subagents.filter((s) => s.status === 'unknown').length;
    return { running, done, error, unknown };
  });

  const hasSummary = $derived(counts.running + counts.done + counts.error + counts.unknown > 0);

  // Cursor-style ordering: live agents first, then failures, then settled;
  // most recently active first within each group.
  const sorted = $derived(orderSubagents(subagents));

  async function refresh({ soft = false } = {}) {
    const loadGeneration = ++generation;
    if (!soft) loading = true;
    loadError = '';
    const result = await settle(() => defaultFetchSubagents(session));
    if (result.ok) {
      if (loadGeneration === generation) {
        subagents = result.value.subagents.map(normalizeSubagent);
      }
    } else if (loadGeneration === generation) {
      loadError = describeError(result.error);
    }
    if (loadGeneration === generation) loading = false;
  }

  function scheduleRefresh() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      refresh({ soft: true });
    }, 300);
  }

  function cardHref(subagent: Subagent): string {
    return withBasePath(subagentTranscriptHref(subagent));
  }

  onMount(() => {
    const previousTitle = document.title;
    document.title = t('subagents.title');
    const statusEvents = createStatusEvents({
      onMessage: (message) => {
        if (message === 'new-session') scheduleRefresh();
      },
      onSnapshot: scheduleRefresh,
      onDelta: scheduleRefresh,
      // Catch up on reconnect the same way SessionsPage does — otherwise the
      // list stays stale until an unrelated broadcast happens to arrive.
      onReconnect: scheduleRefresh,
    });
    recoverSync(() => statusEvents.connect(), undefined);
    refresh();
    return () => {
      document.title = previousTitle;
      clearTimeout(updateTimer);
      statusEvents.cleanup?.();
    };
  });
</script>

{#snippet subagentCardBody(subagent: Subagent)}
  {@const activity = subagentActivityTime(subagent)}
  {@const project = subagentProject(subagent)}
  <span class="subagent-card-body">
    <span class="subagent-marker" aria-hidden="true">
      {#if subagent.status === 'running'}
        <span class="subagent-status-pulse"></span>
      {:else if subagent.status === 'done'}
        {@html icon(Check, { size: 13 })}
      {:else if subagent.status === 'error'}
        {@html icon(X, { size: 13 })}
      {:else}
        <span class="subagent-marker-unknown">–</span>
      {/if}
    </span>
    <span class="subagent-card-main">
      <span class="subagent-card-title-row">
        <span class="subagent-status-chip" data-status={subagent.status}>
          {#if subagent.status === 'running'}<span class="subagent-status-pulse"></span>{/if}
          {t(`subagents.status.${subagent.status}`)}
        </span>
        <strong>{subagent.title || t('subagents.untitled')}</strong>
        {#if subagent.id}<span class="subagent-list-id">{subagent.id}</span>{/if}
      </span>
      <span class="subagent-card-meta">
        {#if subagent.harness}
          <span class="subagent-harness-badge">{subagent.harness}</span>
        {/if}
        {#if project}
          <span class="subagent-list-project" title={project}>{shortenPath(project)}</span>
        {/if}
      </span>
    </span>
    <span class="subagent-card-times">
      {#if activity && activity !== subagent.spawnedAt}
        <span class="subagent-active-time"
          >{t('subagents.active', { time: formatRelativeTime(activity) })}</span
        >
      {/if}
      {#if subagent.spawnedAt}
        <span>{t('subagents.spawned', { time: formatRelativeTime(subagent.spawnedAt) })}</span>
      {/if}
    </span>
    <span class="subagent-card-open" aria-hidden="true">→</span>
  </span>
{/snippet}

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->

<div class="session-header-bar session-header-bar--subagents">
  <div class="session-header-left">
    <button
      type="button"
      class="session-header-back subagents-back"
      onclick={() => navigate(session ? '/session?id=' + encodeURIComponent(session) : '/')}
    >
      <span aria-hidden="true">{@html icon(ChevronLeft, { size: 16 })}</span>
      {t('session.back')}
    </button>
  </div>
  <span class="session-header-title session-header-title--route">
    <span class="session-header-route-mark" aria-hidden="true"
      >{@html icon(Layers, { size: 15 })}</span
    ><span>{t('subagents.title')}</span>
  </span>
  <div class="session-header-right"></div>
</div>

<main class="subagents-page" data-subagents-page>
  {#if session}
    <a
      class="workflow-session-scope"
      href={withBasePath('/session?id=' + encodeURIComponent(session))}
      >{t('subagents.sessionScope')}</a
    >
  {/if}

  {#if loadError}<p class="subagents-page-error" role="alert">{loadError}</p>{/if}

  {#if loading}
    <div class="subagents-loading" aria-live="polite">{t('subagents.loading')}</div>
  {:else if subagents.length === 0}
    <div class="subagents-empty">
      <span aria-hidden="true">{@html icon(Layers, { size: 32 })}</span>
      <h1>{t('subagents.emptyTitle')}</h1>
      <p>{t('subagents.emptyHint')}</p>
    </div>
  {:else}
    {#if hasSummary}
      <div class="subagents-summary" aria-label={t('subagents.title')}>
        {#if counts.running > 0}
          <span class="subagents-summary-item" data-summary="running"
            ><span class="subagents-summary-dot"></span>
            {t('subagents.summary.running', { count: counts.running })}</span
          >
        {/if}
        {#if counts.done > 0}
          <span class="subagents-summary-item" data-summary="done"
            ><span class="subagents-summary-dot"></span>
            {t('subagents.summary.done', { count: counts.done })}</span
          >
        {/if}
        {#if counts.error > 0}
          <span class="subagents-summary-item" data-summary="failed"
            ><span class="subagents-summary-dot"></span>
            {t('subagents.summary.failed', { count: counts.error })}</span
          >
        {/if}
        {#if counts.unknown > 0}
          <span class="subagents-summary-item" data-summary="unknown"
            ><span class="subagents-summary-dot"></span>
            {t('subagents.summary.unknown', { count: counts.unknown })}</span
          >
        {/if}
      </div>
    {/if}

    <div class="subagents-list" role="list">
      {#each sorted as subagent (`${subagent.parentSession}:${subagent.id}:${subagent.childSession}`)}
        {@const href = cardHref(subagent)}
        <article class="subagent-card" data-status={subagent.status} role="listitem">
          {#if href}
            <a
              class="subagent-card-link"
              {href}
              onclick={(event) => handleNavClick(event, href)}
              aria-label="{subagent.title || t('subagents.untitled')} · {t(
                `subagents.status.${subagent.status}`,
              )}"
            >
              {@render subagentCardBody(subagent)}
            </a>
          {:else}
            {@render subagentCardBody(subagent)}
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</main>
