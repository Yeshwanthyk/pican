<script lang="ts">
  import { onMount } from 'svelte';
  import { formatRelativeTime } from '../index/sessions';
  import { handleNavClick, navigate } from '../shared/navigation';
  import { shortenPath } from '../session/render/session-format';
  import { createStatusEvents } from '../shared/status-events';
  import { icon, ChevronLeft, Layers } from '../shared/icons';
  import { t } from '../shared/strings';
  import {
    defaultFetchSubagents,
    normalizeSubagent,
    subagentActivityTime,
    subagentProject,
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

  function sessionURL(value: string) {
    return withBasePath('/session?id=' + encodeURIComponent(value));
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

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->

<div class="session-header-bar">
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
  <span class="session-header-title">{t('subagents.title')}</span>
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
    <div class="subagents-list" role="list">
      {#each subagents as subagent, index (`${subagent.parentSession}:${subagent.id}:${subagent.childSession}:${index}`)}
        {@const activity = subagentActivityTime(subagent)}
        {@const project = subagentProject(subagent)}
        <article class="subagent-list-row" role="listitem">
          <div class="subagent-list-primary">
            <div class="subagent-list-title-row">
              <span class="subagent-status-chip" data-status={subagent.status}>
                {#if subagent.status === 'running'}<span class="subagent-status-pulse"></span>{/if}
                {t(`subagents.status.${subagent.status}`)}
              </span>
              <strong>{subagent.title || t('subagents.untitled')}</strong>
              {#if subagent.id}<span class="subagent-list-id">{subagent.id}</span>{/if}
              {#if subagent.harness}<span class="subagent-harness-badge">{subagent.harness}</span
                >{/if}
            </div>
            {#if project}<span class="subagent-list-project" title={project}
                >{shortenPath(project)}</span
              >{/if}
            <div class="subagent-list-actions subagent-list-actions-mobile">
              {#if subagent.childSession}
                <a
                  href={sessionURL(subagent.childSession)}
                  onclick={(event) => handleNavClick(event, sessionURL(subagent.childSession))}
                  >{t('subagents.transcript')}</a
                >
              {/if}
              {#if subagent.parentSession}
                <a
                  href={sessionURL(subagent.parentSession)}
                  onclick={(event) => handleNavClick(event, sessionURL(subagent.parentSession))}
                  >{t('subagents.parent')}</a
                >
              {/if}
            </div>
          </div>
          <div class="subagent-list-secondary">
            <div class="subagent-list-times">
              {#if subagent.spawnedAt}
                <span
                  >{t('subagents.spawned', { time: formatRelativeTime(subagent.spawnedAt) })}</span
                >
              {/if}
              {#if activity && activity !== subagent.spawnedAt}
                <span>{t('subagents.active', { time: formatRelativeTime(activity) })}</span>
              {/if}
            </div>
            <div class="subagent-list-actions">
              {#if subagent.childSession}
                <a
                  href={sessionURL(subagent.childSession)}
                  onclick={(event) => handleNavClick(event, sessionURL(subagent.childSession))}
                  >{t('subagents.transcript')}</a
                >
              {/if}
              {#if subagent.parentSession}
                <a
                  href={sessionURL(subagent.parentSession)}
                  onclick={(event) => handleNavClick(event, sessionURL(subagent.parentSession))}
                  >{t('subagents.parent')}</a
                >
              {/if}
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</main>
