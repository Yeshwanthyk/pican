<script>
  import { onMount } from 'svelte';
  import { createStatusEvents } from '../shared/status-events.js';
  import { navigate } from '../shared/navigation.js';
  import { t } from '../shared/i18n.js';
  import { icon, ChevronLeft, ListChecks } from '../shared/icons.js';
  import { defaultFetchProjects } from '../index/sessions.js';
  import TaskCard from '../components/tasks/TaskCard.svelte';
  import {
    defaultFetchTaskOutput,
    defaultFetchTasks,
    shortSessionId,
    storesForSelection,
    taskCount,
    taskGroupsByStatus,
    tasksSelectionStorageKey,
  } from '../tasks/tasks.js';

  let { project = '', session = '' } = $props();
  let projects = $state([]);
  let selected = $state('');
  let stores = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let generation = 0;
  let updateTimer = null;

  const selectedStores = $derived(storesForSelection(stores, selected));
  const inProgress = $derived(taskGroupsByStatus(selectedStores, 'in_progress'));
  const pending = $derived(taskGroupsByStatus(selectedStores, 'pending'));
  const completed = $derived(taskGroupsByStatus(selectedStores, 'completed'));

  function queryProject() {
    return selected === 'global' ? projects[0]?.path || '' : selected;
  }

  async function refresh({ soft = false } = {}) {
    const currentProject = queryProject();
    const currentSelection = selected;
    const loadGeneration = ++generation;
    if (!soft) loading = true;
    loadError = '';
    if (!currentProject) {
      stores = [];
      loading = false;
      return;
    }
    try {
      const response = await defaultFetchTasks(currentProject, session);
      if (loadGeneration === generation && currentSelection === selected) {
        stores = response.stores || [];
      }
    } catch (error) {
      if (loadGeneration === generation) loadError = error.message || String(error);
    } finally {
      if (loadGeneration === generation) loading = false;
    }
  }

  function selectProject(value) {
    selected = value;
    localStorage.setItem(tasksSelectionStorageKey, value);
    const suffix = value ? '?project=' + encodeURIComponent(value) : '';
    navigate('/tasks' + suffix);
    refresh();
  }

  async function chooseInitialSelection() {
    if (session && project) {
      projects = [{ path: project }];
      selected = project;
      return;
    }
    const response = await defaultFetchProjects();
    projects = (response.projects || []).filter((entry) => entry?.path);
    const saved = localStorage.getItem(tasksSelectionStorageKey) || '';
    const requested = project === 'global' || projects.some((entry) => entry.path === project);
    if (requested) selected = project;
    else if (saved === 'global' || projects.some((entry) => entry.path === saved)) selected = saved;
    else if (projects.length === 1) selected = projects[0].path;
    else if (projects.length > 1) {
      const probes = await Promise.all(
        projects.map(async (entry) => {
          try {
            const response = await defaultFetchTasks(entry.path);
            const count = storesForSelection(response.stores || [], entry.path).reduce(
              (total, store) => total + store.tasks.length,
              0,
            );
            return count > 0 ? entry.path : '';
          } catch {
            return '';
          }
        }),
      );
      const withTasks = probes.filter(Boolean);
      if (withTasks.length === 1) selected = withTasks[0];
    }
    if (!selected && projects.length > 0) selected = projects[0].path;
    if (selected) localStorage.setItem(tasksSelectionStorageKey, selected);
  }

  function scheduleRefresh(payload) {
    if (selected !== 'global' && payload.project !== selected) return;
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => refresh({ soft: true }), 150);
  }

  onMount(() => {
    const previousTitle = document.title;
    document.title = t('tasks.title');
    const statusEvents = createStatusEvents({ onTasksUpdate: scheduleRefresh });
    try {
      statusEvents.connect();
    } catch {}
    chooseInitialSelection()
      .then(() => refresh())
      .catch((error) => {
        loadError = error.message || String(error);
        loading = false;
      });
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
      class="session-header-back tasks-back"
      onclick={() => navigate(session ? '/session?id=' + encodeURIComponent(session) : '/')}
    >
      <span aria-hidden="true">{@html icon(ChevronLeft, { size: 16 })}</span>
      {t('session.back')}
    </button>
  </div>
  <span class="session-header-title">{t('tasks.title')}</span>
  <div class="session-header-right"></div>
</div>

<main class="tasks-page" data-tasks-page>
  {#if session}
    <a class="tasks-session-scope" href={'/session?id=' + encodeURIComponent(session)}
      >{t('tasks.sessionScope')}</a
    >
  {:else}
    <header class="tasks-toolbar">
      <label for="tasks-project">{t('tasks.project')}</label>
      <select
        id="tasks-project"
        value={selected}
        onchange={(event) => selectProject(event.currentTarget.value)}
      >
        <option value="global">{t('tasks.global')}</option>
        {#each projects as entry (entry.path)}
          <option value={entry.path}>{entry.path}</option>
        {/each}
      </select>
    </header>
  {/if}

  {#if loadError}<p class="tasks-page-error" role="alert">{loadError}</p>{/if}

  {#if loading}
    <div class="tasks-loading" aria-live="polite">{t('tasks.loading')}</div>
  {:else if taskCount(inProgress) + taskCount(pending) + taskCount(completed) === 0}
    <div class="tasks-empty">
      <span aria-hidden="true">{@html icon(ListChecks, { size: 32 })}</span>
      <h1>{t('tasks.emptyTitle')}</h1>
      <p>{t('tasks.emptyHint')}</p>
    </div>
  {:else}
    <div class="tasks-board">
      {#each [{ key: 'in_progress', title: t('tasks.inProgress'), groups: inProgress }, { key: 'pending', title: t('tasks.pending'), groups: pending }, { key: 'completed', title: t('tasks.completed'), groups: completed }] as section (section.key)}
        <section class="task-column" data-status={section.key}>
          <details open={section.key !== 'completed' || taskCount(section.groups) <= 10}>
            <summary class="task-column-header">
              <span>{section.title}</span><span>{taskCount(section.groups)}</span>
            </summary>
            <div class="task-column-content">
              {#each section.groups as store (store.path)}
                {#if selectedStores.length > 1}
                  <div class="task-store-header">
                    {store.scope === 'session'
                      ? t('tasks.storeSession', { id: shortSessionId(store.sessionId) })
                      : t(`tasks.store.${store.scope}`)}
                  </div>
                {/if}
                <div class="task-store-list">
                  {#each store.tasks as task (`${store.path}:${task.id}`)}
                    <TaskCard
                      {task}
                      project={queryProject()}
                      fetchOutput={defaultFetchTaskOutput}
                    />
                  {/each}
                </div>
              {/each}
            </div>
          </details>
        </section>
      {/each}
    </div>
  {/if}
</main>
