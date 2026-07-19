<script lang="ts">
  import { onMount } from 'svelte';
  import { icon, ChevronDown } from '../../shared/icons.js';
  import { loadJSON, saveJSON } from '../../shared/storage.js';
  import { t } from '../../shared/strings.js';
  import {
    collapsedProjectsStorageKey,
    type DateBucket,
    groupSessionsByDate,
    groupSessionsByProject,
    sessionsCountLabel,
    splitPinnedSessions,
    type NormalizedSession,
    type RunningStatus,
    type DateSessionGroup,
    type ProjectSessionGroup,
  } from '../../index/sessions.js';
  import type { NormalizedPeerHost } from '../../index/peers.js';
  import MachinesSection from './MachinesSection.svelte';
  import SessionCard from './SessionCard.svelte';

  const dateBucketLabels: Readonly<Record<DateBucket, string>> = {
    today: 'index.dateToday',
    yesterday: 'index.dateYesterday',
    previous7days: 'index.datePrevious7Days',
    previous30days: 'index.datePrevious30Days',
    older: 'index.dateOlder',
  };

  interface Props {
    sessions?: ReadonlyArray<NormalizedSession>;
    layout?: 'timeline' | 'projects';
    runningSessionIds?: ReadonlySet<string>;
    runningStatuses?: ReadonlyMap<string, RunningStatus>;
    loading?: boolean;
    layoutReady?: boolean;
    hasMore?: boolean;
    loadingMore?: boolean;
    onLoadMore?: () => void | Promise<void>;
    peerHosts?: ReadonlyArray<NormalizedPeerHost>;
  }

  let {
    sessions = [],
    layout = 'timeline',
    runningSessionIds = new Set(),
    runningStatuses = new Map(),
    loading = false,
    layoutReady = false,
    hasMore = false,
    loadingMore = false,
    onLoadMore = () => {},
    peerHosts = [],
  }: Props = $props();

  let now = $state(Date.now());
  let collapsed = $state<Record<string, true>>({});

  const isTimeline = $derived(layout === 'timeline');
  const split = $derived(splitPinnedSessions(sessions));
  const pinnedSessions = $derived(split.pinned);
  const timelineGroups = $derived(groupSessionsByDate(split.rest, now));
  const projectGroups = $derived(groupSessionsByProject(split.rest));

  function readCollapsed(): Record<string, true> {
    const stored = loadJSON(collapsedProjectsStorageKey, {});
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    const result: Record<string, true> = {};
    for (const [project, value] of Object.entries(stored)) {
      if (value === true || value === 1) result[project] = true;
    }
    return result;
  }

  function writeCollapsed(state: Readonly<Record<string, true>>): void {
    saveJSON(collapsedProjectsStorageKey, state);
  }

  function toggleProject(project: string): void {
    if (collapsed[project]) {
      const next = { ...collapsed };
      delete next[project];
      collapsed = next;
    } else {
      collapsed = { ...collapsed, [project]: true };
    }
    writeCollapsed(collapsed);
  }

  function runningCountFor(
    group: DateSessionGroup<NormalizedSession> | ProjectSessionGroup<NormalizedSession>,
  ): number {
    return group.sessions.filter((session) => runningSessionIds.has(session.id)).length;
  }

  onMount(() => {
    collapsed = readCollapsed();
    const timer = setInterval(() => {
      now = Date.now();
    }, 60000);
    return () => clearInterval(timer);
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div
  class="content"
  class:content--timeline={isTimeline}
  class:index-layout-ready={layoutReady}
  data-sessions-content
>
  {#if loading && sessions.length === 0}
    <div class="empty-state">
      <h3>{t('index.loadingSessions')}</h3>
      <p>{t('index.loadingSessionsHint')}</p>
    </div>
  {:else if sessions.length === 0}
    <div class="empty-state">
      <h3>{t('index.noSessionsYet')}</h3>
      <p>{t('index.noSessionsYetHint')}</p>
    </div>
  {:else}
    {#if pinnedSessions.length > 0}
      <div class="timeline-section" data-bucket="pinned">
        <div class="date-separator">
          <span class="date-separator-label">{t('index.pinned')}</span>
          <span class="date-separator-count">{sessionsCountLabel(pinnedSessions.length)}</span>
        </div>
        <div class="session-grid">
          {#each pinnedSessions as session (session.id)}
            <SessionCard
              {session}
              running={runningSessionIds.has(session.id)}
              runningStatus={runningStatuses.get(session.id)}
              {now}
            />
          {/each}
        </div>
      </div>
    {/if}
    {#if peerHosts.length > 0}
      <MachinesSection hosts={peerHosts} {now} />
    {/if}
    {#if isTimeline}
      {#each timelineGroups as group (group.bucket)}
        {@const runningCount = runningCountFor(group)}
        <div class="timeline-section" data-bucket={group.bucket}>
          <div class="date-separator">
            <span class="date-separator-label">{t(dateBucketLabels[group.bucket])}</span>
            <span class="date-separator-count" data-running={runningCount}>
              {runningCount > 0
                ? t('index.activeCount', { count: runningCount })
                : sessionsCountLabel(group.sessions.length)}
            </span>
          </div>
          <div class="session-grid">
            {#each group.sessions as session (session.id)}
              <SessionCard
                {session}
                running={runningSessionIds.has(session.id)}
                runningStatus={runningStatuses.get(session.id)}
                {now}
              />
            {/each}
          </div>
        </div>
      {/each}
    {:else}
      {#each projectGroups as group (group.project + ':' + group.sessions[0]?.id)}
        {@const runningCount = runningCountFor(group)}
        {@const isCollapsed = !!collapsed[group.project]}
        <div class="project-group" class:collapsed={isCollapsed} data-project={group.project}>
          <button
            class="project-toggle"
            type="button"
            aria-expanded={!isCollapsed}
            onclick={() => toggleProject(group.project)}
          >
            <span class="project-chevron" aria-hidden="true"
              >{@html icon(ChevronDown, { size: 12 })}</span
            >
            <span class="project-name">{group.project}</span>
            <span
              class="project-count"
              data-project-count
              data-running={runningCount}
              data-total={group.sessions.length}
            >
              {runningCount > 0
                ? t('index.activeCount', { count: runningCount })
                : sessionsCountLabel(group.sessions.length)}
            </span>
          </button>
          <div class="session-grid">
            {#each group.sessions as session (session.id)}
              <SessionCard
                {session}
                running={runningSessionIds.has(session.id)}
                runningStatus={runningStatuses.get(session.id)}
                {now}
              />
            {/each}
          </div>
        </div>
      {/each}
    {/if}
    {#if hasMore}
      <div class="load-more">
        <button class="load-more-btn" type="button" onclick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? t('index.loadingMore') : t('index.loadMore')}
        </button>
      </div>
    {/if}
  {/if}
</div>
