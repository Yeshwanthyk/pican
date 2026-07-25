<script lang="ts">
  import { onMount } from 'svelte';
  import { handleNavClick } from '../../shared/navigation.js';
  import { t } from '../../shared/strings.js';
  import {
    type DateBucket,
    groupSessionsByDate,
    groupTrackedProjectSessions,
    sessionsCountLabel,
    splitHomeSessions,
    type NormalizedSession,
    type RunningStatus,
    type SessionView,
  } from '../../index/sessions.js';
  import type { Project } from '../../lib/schema';
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
    projects?: ReadonlyArray<Project>;
    view?: SessionView;
    project?: string;
    runningSessionIds?: ReadonlySet<string>;
    runningStatuses?: ReadonlyMap<string, RunningStatus>;
    loading?: boolean;
    hasMore?: boolean;
    loadingMore?: boolean;
    onLoadMore?: () => void | Promise<void>;
    onAddProject?: () => void;
  }

  let {
    sessions = [],
    projects = [],
    view = 'home',
    project = '',
    runningSessionIds = new Set(),
    runningStatuses = new Map(),
    loading = false,
    hasMore = false,
    loadingMore = false,
    onLoadMore = () => {},
    onAddProject = () => {},
  }: Props = $props();

  let now = $state(Date.now());

  const isHome = $derived(!project && view === 'home');
  const split = $derived(splitHomeSessions(sessions, runningSessionIds));
  const nowSessions = $derived([...split.live, ...split.waiting]);
  const pinnedSessions = $derived(split.pinned);
  const trackedProjects = $derived(projects.filter((candidate) => candidate.tracked));
  const projectGroups = $derived(groupTrackedProjectSessions(split.rest, projects));
  const timelineGroups = $derived(groupSessionsByDate(isHome ? [] : sessions, now));

  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 60000);
    return () => clearInterval(timer);
  });
</script>

<div
  class="content"
  class:content--timeline={!isHome}
  class:index-layout-ready={!loading}
  data-sessions-content
  data-scope={project ? 'project' : view}
>
  {#if loading && sessions.length === 0}
    <div class="empty-state plain-state">
      <div class="plain-state-line">{t('index.loadingSessions')}</div>
      <div class="plain-state-hint">{t('index.loadingSessionsHint')}</div>
    </div>
  {:else if isHome}
    {#if nowSessions.length > 0}
      <section class="timeline-section timeline-section--now" data-bucket="now">
        <div class="date-separator">
          <span class="date-separator-label">{t('index.now')}</span>
          <span class="date-separator-count">{sessionsCountLabel(nowSessions.length)}</span>
        </div>
        <div class="session-grid">
          {#each nowSessions as session (session.id)}
            <SessionCard
              {session}
              running={runningSessionIds.has(session.id)}
              runningStatus={runningStatuses.get(session.id)}
              {now}
            />
          {/each}
        </div>
      </section>
    {/if}
    {#if pinnedSessions.length > 0}
      <section class="timeline-section" data-bucket="pinned">
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
      </section>
    {/if}
    {#if trackedProjects.length === 0}
      <div class="empty-state plain-state tracked-projects-empty" data-empty="tracked-projects">
        <div class="plain-state-line">{t('index.noTrackedProjects')}</div>
        <div class="plain-state-hint">
          {t('index.noTrackedProjectsHint')}
          <a href="/?view=all" onclick={(event) => handleNavClick(event, '/?view=all')}
            >{t('index.openAllSessions')}</a
          >
        </div>
        <button class="btn-primary empty-add-project" type="button" onclick={onAddProject}
          >{t('index.addProject')}</button
        >
      </div>
    {:else}
      {#each projectGroups as group (group.project)}
        <section class="project-group" data-project={group.project}>
          <div class="project-toggle project-toggle--static">
            <a
              class="project-name"
              href={'/?project=' + encodeURIComponent(group.project)}
              title={group.project}
              onclick={(event) =>
                handleNavClick(event, '/?project=' + encodeURIComponent(group.project))}
              >{group.project}</a
            >
            <a
              class="project-count project-view-all"
              href={'/?project=' + encodeURIComponent(group.project)}
              onclick={(event) =>
                handleNavClick(event, '/?project=' + encodeURIComponent(group.project))}
              >{t('index.viewAllCount', { count: group.total })}</a
            >
          </div>
          {#if group.sessions.length > 0}
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
          {:else}
            <div class="project-empty-preview">{t('index.noProjectSessions')}</div>
          {/if}
        </section>
      {/each}
    {/if}
  {:else if sessions.length === 0}
    <div class="empty-state plain-state" data-empty={project ? 'project' : view}>
      <div class="plain-state-line">
        {project
          ? t('index.noProjectSessions')
          : view === 'archived'
            ? t('index.noArchivedSessions')
            : t('index.noSessionsYet')}
      </div>
      {#if view === 'archived' && !project}
        <div class="plain-state-hint">{t('index.noArchivedSessionsHint')}</div>
      {/if}
    </div>
  {:else}
    {#each timelineGroups as group (group.bucket)}
      <section class="timeline-section" data-bucket={group.bucket}>
        <div class="date-separator">
          <span class="date-separator-label">{t(dateBucketLabels[group.bucket])}</span>
          <span class="date-separator-count">{sessionsCountLabel(group.sessions.length)}</span>
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
      </section>
    {/each}
  {/if}
  {#if !isHome && hasMore}
    <div class="load-more">
      <button class="load-more-btn" type="button" onclick={onLoadMore} disabled={loadingMore}>
        {loadingMore ? t('index.loadingMore') : t('index.loadMore')}
      </button>
    </div>
  {/if}
</div>
