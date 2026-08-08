<script lang="ts">
  import { onMount } from 'svelte';
  import { handleNavClick } from '../../shared/navigation.js';
  import { t } from '../../shared/strings.js';
  import {
    type DateBucket,
    groupSessionsByDate,
    groupTrackedProjectSessions,
    projectDisplayName,
    sessionsCountLabel,
    splitHomeSessions,
    type NormalizedSession,
    type RunningStatus,
    type SessionView,
  } from '../../index/sessions.js';
  import type { Project } from '../../lib/schema';
  import ActivityGroup from './ActivityGroup.svelte';
  import SessionCard from './SessionCard.svelte';
  import { withBasePath } from '../../shared/base-path.js';

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

  const PIN_PREVIEW_LIMIT = 8;
  let now = $state(Date.now());
  let allPinsVisible = $state(false);

  const isHome = $derived(!project && view === 'home');
  const trackedProjects = $derived(projects.filter((candidate) => candidate.tracked));
  const trackedProjectPaths = $derived(new Set(trackedProjects.map((candidate) => candidate.path)));
  const split = $derived(splitHomeSessions(sessions, runningSessionIds, trackedProjectPaths));
  const nowSessions = $derived([...split.live, ...split.waiting]);
  const pinnedSessions = $derived(split.pinned);
  const visiblePinnedSessions = $derived(
    allPinsVisible ? pinnedSessions : pinnedSessions.slice(0, PIN_PREVIEW_LIMIT),
  );
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
    <div class="home-feed activity-feed" data-home-feed>
      <ActivityGroup
        id="pinned"
        title={t('index.pinned')}
        count={pinnedSessions.length <= PIN_PREVIEW_LIMIT
          ? sessionsCountLabel(pinnedSessions.length)
          : ''}
        actionLabel={pinnedSessions.length > PIN_PREVIEW_LIMIT
          ? allPinsVisible
            ? t('index.showFewerPins')
            : t('index.showAllPins', { count: pinnedSessions.length })
          : ''}
        actionExpanded={allPinsVisible}
        onAction={() => (allPinsVisible = !allPinsVisible)}
        bucket="pinned"
      >
        {#if pinnedSessions.length === 0}
          <div class="activity-group-empty" data-empty="pinned">
            <span>{t('index.noPinnedSessions')}</span>
            <span class="activity-group-empty-hint">{t('index.noPinnedSessionsHint')}</span>
          </div>
        {:else}
          {#each visiblePinnedSessions as session (session.id)}
            <div class="home-feed-session" data-bucket="pinned">
              <SessionCard
                {session}
                running={runningSessionIds.has(session.id)}
                runningStatus={runningStatuses.get(session.id)}
                {now}
              />
            </div>
          {/each}
        {/if}
      </ActivityGroup>

      <ActivityGroup
        id="now"
        title={t('index.now')}
        count={sessionsCountLabel(nowSessions.length)}
        bucket="now"
        spaced={true}
      >
        {#if nowSessions.length === 0}
          <div class="activity-group-empty" data-empty="now">
            <span>{t('index.noActiveSessions')}</span>
          </div>
        {:else}
          {#each nowSessions as session (session.id)}
            <div class="home-feed-session" data-bucket="now">
              <SessionCard
                {session}
                running={runningSessionIds.has(session.id)}
                runningStatus={runningStatuses.get(session.id)}
                {now}
              />
            </div>
          {/each}
        {/if}
      </ActivityGroup>

      <ActivityGroup
        id="projects"
        title={t('index.projects')}
        variant="projects"
        spaced={true}
      >
        {#if trackedProjects.length === 0}
          <div class="empty-state plain-state tracked-projects-empty" data-empty="tracked-projects">
            <div class="plain-state-line">{t('index.noTrackedProjects')}</div>
            <div class="plain-state-hint">
              {t('index.noTrackedProjectsHint')}
              <a
                href={withBasePath('/?view=all')}
                onclick={(event) => handleNavClick(event, '/?view=all')}
                >{t('index.openAllSessions')}</a
              >
            </div>
            <button class="btn-primary empty-add-project" type="button" onclick={onAddProject}
              >{t('index.addProject')}</button
            >
          </div>
        {:else}
          {#each projectGroups as group, groupIndex (group.project)}
            <ActivityGroup
              id={`project-${groupIndex}`}
              title={projectDisplayName(group.project)}
              headingTitle={group.project}
              href={'/?project=' + encodeURIComponent(group.project)}
              actionLabel={t('index.viewAllCount', { count: group.total })}
              level={3}
              project={group.project}
              variant="project"
              spaced={true}
            >
              {#if group.sessions.length === 0}
                <div class="project-empty-preview" data-project={group.project}>
                  {t('index.noProjectSessions')}
                </div>
              {:else}
                {#each group.sessions as session (session.id)}
                  <div class="home-feed-session" data-project={group.project}>
                    <SessionCard
                      {session}
                      running={runningSessionIds.has(session.id)}
                      runningStatus={runningStatuses.get(session.id)}
                      {now}
                    />
                  </div>
                {/each}
              {/if}
            </ActivityGroup>
          {/each}
        {/if}
      </ActivityGroup>
    </div>
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
      <ActivityGroup
        id={`timeline-${group.bucket}`}
        title={t(dateBucketLabels[group.bucket])}
        count={sessionsCountLabel(group.sessions.length)}
        bucket={group.bucket}
      >
        {#each group.sessions as session (session.id)}
          <SessionCard
            {session}
            running={runningSessionIds.has(session.id)}
            runningStatus={runningStatuses.get(session.id)}
            {now}
          />
        {/each}
      </ActivityGroup>
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
