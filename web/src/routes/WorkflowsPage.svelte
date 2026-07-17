<script>
  import { onMount } from 'svelte';
  import { createStatusEvents } from '../shared/status-events.js';
  import { navigate } from '../shared/navigation.js';
  import { t } from '../shared/i18n.js';
  import { formatRelativeTime } from '../index/sessions.js';
  import { icon, ChevronLeft, ListTree } from '../shared/icons.js';
  import WorkflowDetail from '../components/workflows/WorkflowDetail.svelte';
  import WorkflowStatusChip from '../components/workflows/WorkflowStatusChip.svelte';
  import {
    defaultFetchWorkflowRun,
    defaultFetchWorkflows,
    normalizeWorkflowSummary,
    workflowPhaseProgress,
  } from '../workflows/workflows.js';

  let { runId = '' } = $props();

  let workflows = $state([]);
  let loading = $state(true);
  let loadError = $state('');
  let detail = $state(null);
  let detailLoading = $state(false);
  let detailError = $state('');
  let listGeneration = 0;
  let detailGeneration = 0;
  let updateTimer = null;

  async function refreshList({ soft = false } = {}) {
    const generation = ++listGeneration;
    if (!soft) loading = true;
    loadError = '';
    try {
      const response = await defaultFetchWorkflows();
      if (generation !== listGeneration) return;
      workflows = (response.workflows || []).map(normalizeWorkflowSummary);
    } catch (error) {
      if (generation === listGeneration) loadError = error.message || String(error);
    } finally {
      if (generation === listGeneration) loading = false;
    }
  }

  async function refreshDetail(selectedRunId, { soft = false } = {}) {
    const generation = ++detailGeneration;
    if (!soft) {
      detail = null;
      detailLoading = true;
    }
    detailError = '';
    try {
      const response = await defaultFetchWorkflowRun(selectedRunId);
      if (generation === detailGeneration && runId === selectedRunId) detail = response;
    } catch (error) {
      if (generation === detailGeneration && runId === selectedRunId) {
        detailError = error.message || String(error);
      }
    } finally {
      if (generation === detailGeneration) detailLoading = false;
    }
  }

  function scheduleRefresh() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = null;
      refreshList({ soft: true });
      if (runId) refreshDetail(runId, { soft: true });
    }, 150);
  }

  function selectRun(selectedRunId) {
    navigate('/workflows?runId=' + encodeURIComponent(selectedRunId));
  }

  function leavePage() {
    navigate(runId ? '/workflows' : '/');
  }

  $effect(() => {
    const selectedRunId = runId;
    if (selectedRunId) refreshDetail(selectedRunId);
    else {
      detailGeneration += 1;
      detail = null;
      detailError = '';
      detailLoading = false;
    }
  });

  onMount(() => {
    const previousTitle = document.title;
    document.title = t('workflows.title');
    refreshList();
    const statusEvents = createStatusEvents({ onWorkflowUpdate: scheduleRefresh });
    try {
      statusEvents.connect();
    } catch {}
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
    <button type="button" class="session-header-back workflows-back" onclick={leavePage}>
      <span aria-hidden="true">{@html icon(ChevronLeft, { size: 16 })}</span>
      {runId ? t('workflows.title') : t('session.back')}
    </button>
  </div>
  <span class="session-header-title">{t('workflows.title')}</span>
  <div class="session-header-right"></div>
</div>

<main class="workflows-page" data-workflows-page>
  {#if loadError}
    <p class="workflow-page-error" role="alert">{loadError}</p>
  {/if}

  {#if runId}
    {#if detailLoading}
      <div class="workflow-loading" aria-live="polite">{t('workflows.loadingRun')}</div>
    {:else if detailError}
      <div class="workflow-empty">
        <p class="workflow-page-error" role="alert">{detailError}</p>
        <button type="button" class="workflow-button" onclick={() => navigate('/workflows')}
          >{t('workflows.backToList')}</button
        >
      </div>
    {:else if detail}
      <WorkflowDetail {detail} />
    {/if}
  {:else if loading}
    <div class="workflow-loading" aria-live="polite">{t('workflows.loading')}</div>
  {:else if workflows.length === 0}
    <div class="workflow-empty">
      <span aria-hidden="true">{@html icon(ListTree, { size: 32 })}</span>
      <h1>{t('workflows.emptyTitle')}</h1>
      <p>{t('workflows.emptyHint')}</p>
    </div>
  {:else}
    <div class="workflow-list" role="list">
      {#each workflows as workflow (workflow.runId)}
        {@const progress = workflowPhaseProgress(workflow)}
        <div role="listitem">
          <button type="button" class="workflow-list-row" onclick={() => selectRun(workflow.runId)}>
            <span class="workflow-list-primary">
              <span class="workflow-list-title-row">
                <strong>{workflow.name || workflow.runId}</strong>
                <WorkflowStatusChip status={workflow.status} />
              </span>
              {#if workflow.description}<span>{workflow.description}</span>{/if}
            </span>
            <span class="workflow-list-meta">
              <span
                >{workflow.startedAt
                  ? formatRelativeTime(workflow.startedAt)
                  : t('workflows.timeUnknown')}</span
              >
              {#if progress.total > 0}
                <span
                  >{t('workflows.phaseProgress', {
                    current: progress.current,
                    total: progress.total,
                  })}</span
                >
              {/if}
              <span>{t('workflows.agentCount', { count: workflow.agentCount })}</span>
            </span>
          </button>
        </div>
      {/each}
    </div>
  {/if}
</main>
