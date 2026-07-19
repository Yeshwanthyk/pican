<script lang="ts">
  import { onMount } from 'svelte';
  import { createStatusEvents } from '../shared/status-events';
  import { navigate } from '../shared/navigation';
  import { t } from '../shared/strings';
  import { formatRelativeTime } from '../index/sessions';
  import { icon, ChevronLeft, ListTree } from '../shared/icons';
  import WorkflowDetail from '../components/workflows/WorkflowDetail.svelte';
  import WorkflowStatusChip from '../components/workflows/WorkflowStatusChip.svelte';
  import {
    defaultFetchWorkflowRun,
    defaultFetchWorkflows,
    normalizeWorkflowSummary,
    workflowPhaseProgress,
  } from '../workflows/workflows';
  import type { WorkflowSummary } from '../workflows/workflows';
  import type { WorkflowRunDetail } from '../lib/schema';
  import { describeError } from '../lib/errors';
  import { recoverSync, settle } from '../components/shared/ui-effect';

  let { runId = '', session = '' }: { runId?: string; session?: string } = $props();

  let workflows = $state<ReadonlyArray<WorkflowSummary>>([]);
  let loading = $state(true);
  let loadError = $state('');
  let detail = $state<WorkflowRunDetail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state('');
  let listGeneration = 0;
  let detailGeneration = 0;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;

  async function refreshList({ soft = false, sessionFilter = session } = {}) {
    const generation = ++listGeneration;
    if (!soft) loading = true;
    loadError = '';
    const result = await settle(() => defaultFetchWorkflows(sessionFilter));
    if (result.ok) {
      if (generation !== listGeneration) return;
      workflows = result.value.workflows.map(normalizeWorkflowSummary);
    } else if (generation === listGeneration) {
      loadError = describeError(result.error);
    }
    if (generation === listGeneration) loading = false;
  }

  async function refreshDetail(selectedRunId: string, { soft = false }: { soft?: boolean } = {}) {
    const generation = ++detailGeneration;
    if (!soft) {
      detail = null;
      detailLoading = true;
    }
    detailError = '';
    const result = await settle(() => defaultFetchWorkflowRun(selectedRunId));
    if (result.ok) {
      if (generation === detailGeneration && runId === selectedRunId) detail = result.value;
    } else {
      if (generation === detailGeneration && runId === selectedRunId) {
        detailError = describeError(result.error);
      }
    }
    if (generation === detailGeneration) detailLoading = false;
  }

  function scheduleRefresh() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      refreshList({ soft: true });
      if (runId) refreshDetail(runId, { soft: true });
    }, 150);
  }

  function selectRun(selectedRunId: string) {
    navigate(workflowsHref(selectedRunId));
  }

  function workflowsHref(selectedRunId = '') {
    const params: string[] = [];
    if (session) params.push('session=' + encodeURIComponent(session));
    if (selectedRunId) params.push('runId=' + encodeURIComponent(selectedRunId));
    return '/workflows' + (params.length ? '?' + params.join('&') : '');
  }

  function leavePage() {
    if (runId) navigate(workflowsHref());
    else navigate(session ? '/session?id=' + encodeURIComponent(session) : '/');
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

  $effect(() => {
    refreshList({ sessionFilter: session });
  });

  onMount(() => {
    const previousTitle = document.title;
    document.title = t('workflows.title');
    const statusEvents = createStatusEvents({ onWorkflowUpdate: scheduleRefresh });
    recoverSync(() => statusEvents.connect(), undefined);
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
  {#if session}
    <a class="workflow-session-scope" href={'/session?id=' + encodeURIComponent(session)}
      >{t('workflows.sessionScope')}</a
    >
  {/if}

  {#if loadError}
    <p class="workflow-page-error" role="alert">{loadError}</p>
  {/if}

  {#if runId}
    {#if detailLoading}
      <div class="workflow-loading" aria-live="polite">{t('workflows.loadingRun')}</div>
    {:else if detailError}
      <div class="workflow-empty">
        <p class="workflow-page-error" role="alert">{detailError}</p>
        <button type="button" class="workflow-button" onclick={() => navigate(workflowsHref())}
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
