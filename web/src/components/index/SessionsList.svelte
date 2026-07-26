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

  type HomeFeedItem =
    | {
        readonly kind: 'section';
        readonly key: string;
        readonly bucket: 'now' | 'pinned';
        readonly label: string;
        readonly count: number;
        readonly spaced: boolean;
      }
    | {
        readonly kind: 'project';
        readonly key: string;
        readonly project: string;
        readonly total: number;
        readonly spaced: boolean;
      }
    | {
        readonly kind: 'empty-project';
        readonly key: string;
        readonly project: string;
      }
    | {
        readonly kind: 'session';
        readonly key: string;
        readonly bucket?: 'now' | 'pinned';
        readonly project?: string;
        readonly session: NormalizedSession;
      };

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
  const trackedProjects = $derived(projects.filter((candidate) => candidate.tracked));
  const trackedProjectPaths = $derived(new Set(trackedProjects.map((candidate) => candidate.path)));
  const split = $derived(splitHomeSessions(sessions, runningSessionIds, trackedProjectPaths));
  const nowSessions = $derived([...split.live, ...split.waiting]);
  const pinnedSessions = $derived(split.pinned);
  const projectGroups = $derived(groupTrackedProjectSessions(split.rest, projects));
  const timelineGroups = $derived(groupSessionsByDate(isHome ? [] : sessions, now));
  const homeFeed = $derived.by(() => {
    const items: HomeFeedItem[] = [];
    const addSection = (
      bucket: 'now' | 'pinned',
      label: string,
      groupedSessions: ReadonlyArray<NormalizedSession>,
    ) => {
      if (groupedSessions.length === 0) return;
      items.push({
        kind: 'section',
        key: `section:${bucket}`,
        bucket,
        label,
        count: groupedSessions.length,
        spaced: items.length > 0,
      });
      for (const session of groupedSessions) {
        items.push({ kind: 'session', key: `session:${session.id}`, bucket, session });
      }
    };

    addSection('now', t('index.now'), nowSessions);
    addSection('pinned', t('index.pinned'), pinnedSessions);
    for (const group of projectGroups) {
      items.push({
        kind: 'project',
        key: `project:${group.project}`,
        project: group.project,
        total: group.total,
        spaced: items.length > 0,
      });
      if (group.sessions.length === 0) {
        items.push({
          kind: 'empty-project',
          key: `project-empty:${group.project}`,
          project: group.project,
        });
        continue;
      }
      for (const session of group.sessions) {
        items.push({
          kind: 'session',
          key: `session:${session.id}`,
          project: group.project,
          session,
        });
      }
    }
    return items;
  });

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
    <div class="home-feed" data-home-feed>
      {#each homeFeed as item (item.key)}
        {#if item.kind === 'section'}
          <div
            class="date-separator home-feed-heading"
            class:home-feed-heading--spaced={item.spaced}
            data-bucket={item.bucket}
          >
            <span class="date-separator-label">{item.label}</span>
            <span class="date-separator-count">{sessionsCountLabel(item.count)}</span>
          </div>
        {:else if item.kind === 'project'}
          <div
            class="project-toggle project-toggle--static home-feed-heading"
            class:home-feed-heading--spaced={item.spaced}
            data-project={item.project}
          >
            <a
              class="project-name"
              href={withBasePath('/?project=' + encodeURIComponent(item.project))}
              title={item.project}
              onclick={(event) =>
                handleNavClick(event, '/?project=' + encodeURIComponent(item.project))}
              >{item.project}</a
            >
            <a
              class="project-count project-view-all"
              href={withBasePath('/?project=' + encodeURIComponent(item.project))}
              onclick={(event) =>
                handleNavClick(event, '/?project=' + encodeURIComponent(item.project))}
              >{t('index.viewAllCount', { count: item.total })}</a
            >
          </div>
        {:else if item.kind === 'empty-project'}
          <div class="project-empty-preview" data-project={item.project}>
            {t('index.noProjectSessions')}
          </div>
        {:else}
          <div class="home-feed-session" data-bucket={item.bucket} data-project={item.project}>
            <SessionCard
              session={item.session}
              running={runningSessionIds.has(item.session.id)}
              runningStatus={runningStatuses.get(item.session.id)}
              {now}
            />
          </div>
        {/if}
      {/each}
    </div>
    {#if trackedProjects.length === 0}
      <div class="empty-state plain-state tracked-projects-empty" data-empty="tracked-projects">
        <div class="plain-state-line">{t('index.noTrackedProjects')}</div>
        <div class="plain-state-hint">
          {t('index.noTrackedProjectsHint')}
          <a
            href={withBasePath('/?view=all')}
            onclick={(event) => handleNavClick(event, '/?view=all')}>{t('index.openAllSessions')}</a
          >
        </div>
        <button class="btn-primary empty-add-project" type="button" onclick={onAddProject}
          >{t('index.addProject')}</button
        >
      </div>
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
