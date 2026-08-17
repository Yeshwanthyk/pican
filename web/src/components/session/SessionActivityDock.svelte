<script lang="ts">
  import { onMount } from 'svelte';
  import { formatRelativeTime } from '../../index/sessions';
  import { runPromise } from '../../lib/runtime';
  import { shortenPath } from '../../session/render/session-format';
  import { handleNavClick } from '../../shared/navigation';
  import { createStatusEvents } from '../../shared/status-events';
  import { icon, Layers, ListChecks } from '../../shared/icons';
  import { t } from '../../shared/strings';
  import { withBasePath } from '../../shared/base-path';
  import { recoverSync, settle } from '../shared/ui-effect';
  import { effects } from '../../shared/api';
  import {
    defaultFetchSubagents,
    normalizeSubagent,
    orderSubagents,
    subagentActivityTime,
    subagentProject,
    subagentTranscriptHref,
  } from '../../subagents/subagents';
  import type { Subagent } from '../../subagents/subagents';
  import { flattenDockTasks, taskStatusLabelKey } from '../../session/activity-tasks';
  import type { DockTask } from '../../session/activity-tasks';

  let { sessionId = '', projectPath = '', chatAvailable = true } = $props();

  let subagents = $state<ReadonlyArray<Subagent>>([]);
  let tasks = $state<ReadonlyArray<DockTask>>([]);
  // 1s ticker: only re-renders the elapsed labels that read `now`.
  let now = $state(Date.now());
  let generation = 0;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;

  // Keep the current-tab snapshot small: newest first (the task stores are
  // already recency-ordered by the server, but sorting here keeps the dock
  // deterministic regardless of store order) and capped at five rows.
  const MAX_TASKS = 5;
  const agents = $derived(orderSubagents(subagents));
  const dockTasks = $derived.by(() =>
    [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_TASKS),
  );
  // Mobile strip shows one working pill — active (in_progress/pending) tasks
  // only, so a failed task never masquerades as "in progress".
  const firstActiveTask = $derived(
    dockTasks.find((task) => task.status === 'in_progress' || task.status === 'pending') ?? null,
  );

  const runningCount = $derived(agents.filter((agent) => agent.status === 'running').length);
  const doneCount = $derived(agents.filter((agent) => agent.status === 'done').length);
  const failedCount = $derived(agents.filter((agent) => agent.status === 'error').length);
  // Counts over the FULL task list — the rendered rows are capped at MAX_TASKS,
  // so deriving the ribbon numbers from dockTasks would undercount beyond it.
  const activeTaskCount = $derived(
    tasks.filter((task) => task.status === 'in_progress' || task.status === 'pending').length,
  );
  const doneTaskCount = $derived(tasks.filter((task) => task.status === 'completed').length);

  const hasAgents = $derived(agents.length > 0);
  const hasTasks = $derived(dockTasks.length > 0);
  // View-only sessions get no live activity dock; empty state collapses to 0.
  const visible = $derived(chatAvailable && (hasAgents || hasTasks));

  function subagentHref(subagent: Subagent): string {
    const href = subagentTranscriptHref(subagent);
    return href ? withBasePath(href) : '';
  }

  function refresh() {
    // No loading state in the dock: a refresh either lands new data or leaves
    // the previous snapshot in place. Generation keeps racing soft refreshes
    // (status-events, 300ms debounced) from clobbering newer results.
    const loadGeneration = ++generation;
    void settle(() => defaultFetchSubagents(sessionId)).then((result) => {
      if (result.ok && loadGeneration === generation) {
        subagents = result.value.subagents.map(normalizeSubagent);
      }
    });
    if (projectPath) {
      // effects.tasks.list is an Effect; runPromise turns it into the
      // Promise settle() expects, exactly like SubagentsPage settles
      // defaultFetchSubagents.
      void settle(() => runPromise(effects.tasks.list(projectPath, sessionId))).then((result) => {
        if (result.ok && loadGeneration === generation) {
          tasks = flattenDockTasks(result.value);
        }
      });
    }
  }

  function scheduleRefresh() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      refresh();
    }, 300);
  }

  onMount(() => {
    const statusEvents = createStatusEvents({
      onMessage: (message) => {
        if (message === 'new-session') scheduleRefresh();
      },
      onSnapshot: scheduleRefresh,
      onDelta: scheduleRefresh,
      onTasksUpdate: scheduleRefresh,
      // Catch up on reconnect just like SubagentsPage, so a stale dock
      // refreshes even when no unrelated broadcast happens to arrive.
      onReconnect: scheduleRefresh,
    });
    recoverSync(() => statusEvents.connect(), undefined);
    void refresh();
    const reducedMotion =
      (typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) ??
      false;
    if (!reducedMotion) {
      tickTimer = setInterval(() => {
        now = Date.now();
      }, 1000);
    }
    return () => {
      clearTimeout(updateTimer);
      if (tickTimer) clearInterval(tickTimer);
      statusEvents.cleanup?.();
    };
  });
</script>

{#snippet agentRowContent(subagent: Subagent)}
  {@const activity = subagentActivityTime(subagent)}
  {@const project = subagentProject(subagent)}
  <span class="session-dock-agent-dot" data-status={subagent.status} aria-hidden="true"></span>
  <span class="session-dock-agent-title">{subagent.title || t('subagents.untitled')}</span>
  {#if subagent.id}
    <span class="session-dock-agent-id">{subagent.id}</span>
  {/if}
  {#if project}
    <span class="session-dock-agent-project" title={project}>{shortenPath(project)}</span>
  {/if}
  <span class="session-dock-agent-side">
    {#if subagent.status === 'running' && activity}
      <span class="session-dock-agent-elapsed"
        >{t('subagents.active', { time: formatRelativeTime(activity, now) })}</span
      >
    {/if}
    <span class="session-dock-agent-open" aria-hidden="true">→</span>
  </span>
{/snippet}

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->

<div class="session-activity-dock" data-session-activity-dock aria-live="polite" hidden={!visible}>
  {#if hasAgents}
    <section class="session-dock-panel session-dock-agents-panel">
      <header class="session-dock-panel-head">
        <span class="session-dock-panel-title">
          <span aria-hidden="true">{@html icon(Layers, { size: 12 })}</span>
          {t('session.dockAgents')}
        </span>
        <span class="session-dock-counts">
          {#if runningCount > 0}
            <span class="session-dock-count session-dock-count--running" data-count="running"
              ><span class="session-dock-count-dot" aria-hidden="true"></span>
              {t('subagents.summary.running', { count: runningCount })}</span
            >
          {/if}
          {#if doneCount > 0}
            <span class="session-dock-count session-dock-count--done" data-count="done"
              ><span class="session-dock-count-mark" aria-hidden="true">✓</span>
              {t('subagents.summary.done', { count: doneCount })}</span
            >
          {/if}
          {#if failedCount > 0}
            <span class="session-dock-count session-dock-count--failed" data-count="failed"
              ><span class="session-dock-count-mark" aria-hidden="true">✕</span>
              {t('subagents.summary.failed', { count: failedCount })}</span
            >
          {/if}
        </span>
        <a
          class="session-dock-open-all"
          href={withBasePath('/subagents?session=' + encodeURIComponent(sessionId))}
          >{t('session.dockOpenAll')}</a
        >
      </header>
      <div class="session-dock-agent-list" role="list">
        {#each agents as subagent (`${subagent.parentSession}:${subagent.id}:${subagent.childSession}`)}
          {@const href = subagentHref(subagent)}
          <div
            class="session-dock-agent"
            role="listitem"
            data-status={subagent.status}
            class:session-dock-agent--settled={subagent.status === 'done' ||
              subagent.status === 'error'}
          >
            {#if href}
              <a
                class="session-dock-agent-link"
                {href}
                onclick={(event) => handleNavClick(event, href)}
                aria-label="{subagent.title || t('subagents.untitled')} · {t(
                  `subagents.status.${subagent.status}`,
                )}"
              >
                {@render agentRowContent(subagent)}
              </a>
            {:else}
              <span
                class="session-dock-agent-link session-dock-agent-static"
                aria-label="{subagent.title || t('subagents.untitled')} · {t(
                  `subagents.status.${subagent.status}`,
                )}"
              >
                {@render agentRowContent(subagent)}
              </span>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if hasTasks}
    <section class="session-dock-panel session-dock-tasks-panel">
      <header class="session-dock-panel-head">
        <span class="session-dock-panel-title">
          <span aria-hidden="true">{@html icon(ListChecks, { size: 12 })}</span>
          {t('session.dockTasks')}
        </span>
        <span class="session-dock-counts">
          {#if activeTaskCount > 0}
            <span class="session-dock-count session-dock-count--active" data-count="active"
              >{t('session.dockActive', { count: activeTaskCount })}</span
            >
          {/if}
          {#if doneTaskCount > 0}
            <span class="session-dock-count session-dock-count--done" data-count="done"
              >{t('session.dockReady', { count: doneTaskCount })}</span
            >
          {/if}
        </span>
        <a
          class="session-dock-open-all"
          href={withBasePath(
            '/tasks?project=' +
              encodeURIComponent(projectPath) +
              '&session=' +
              encodeURIComponent(sessionId),
          )}>{t('session.dockOpenAll')}</a
        >
      </header>
      <div class="session-dock-task-list">
        {#each dockTasks as task (task.id)}
          {@const labelKey = taskStatusLabelKey(task.status)}
          <div
            class="session-dock-task"
            data-status={task.status}
            class:session-dock-task--done={task.status === 'completed'}
          >
            <span class="session-dock-task-id">#{task.id}</span>
            <span class="session-dock-task-chip">{labelKey ? t(labelKey) : task.status}</span>
            <span class="session-dock-task-subject">{task.subject}</span>
          </div>
        {/each}
      </div>
      {#if firstActiveTask}
        <span class="session-dock-task-pill" data-status={firstActiveTask.status}
          ><span class="session-dock-task-pill-id">#{firstActiveTask.id}</span>
          {firstActiveTask.subject}</span
        >
      {/if}
    </section>
  {/if}
</div>
