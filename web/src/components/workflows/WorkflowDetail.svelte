<script>
  import { marked } from 'marked';
  import { configureSessionMarkdown, safeMarkedParse } from '../../session/render/markdown.js';
  import { escapeHtml } from '../../shared/escape.js';
  import { t } from '../../shared/i18n.js';
  import { formatWorkflowDate } from '../../workflows/workflows.js';
  import WorkflowStatusChip from './WorkflowStatusChip.svelte';
  import WorkflowTranscriptViewer from './WorkflowTranscriptViewer.svelte';

  let { detail } = $props();

  configureSessionMarkdown({ marked, hljs: null, escapeHtml });

  const workflow = $derived(detail?.workflow || {});
  const phases = $derived(Array.isArray(workflow.phases) ? workflow.phases : []);
  const agents = $derived(Array.isArray(workflow.agents) ? workflow.agents : []);
  const md = (text) => safeMarkedParse(String(text || ''), { marked });
  const resultJSON = $derived.by(() => {
    if (detail?.result == null || typeof detail.result === 'string') return '';
    try {
      return JSON.stringify(detail.result, null, 2);
    } catch {
      return String(detail.result);
    }
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- rendered through configured safeMarkedParse -->

<article class="workflow-detail">
  <header class="workflow-detail-header">
    <div>
      <div class="workflow-detail-title-row">
        <h1>{String(workflow.name || workflow.runId || t('workflows.untitled'))}</h1>
        <WorkflowStatusChip status={String(workflow.status || '')} />
      </div>
      {#if workflow.description}<p>{String(workflow.description)}</p>{/if}
    </div>
    <dl class="workflow-detail-meta">
      {#if workflow.startedAt}
        <div>
          <dt>{t('workflows.started')}</dt>
          <dd>{formatWorkflowDate(workflow.startedAt)}</dd>
        </div>
      {/if}
      {#if workflow.finishedAt}
        <div>
          <dt>{t('workflows.finished')}</dt>
          <dd>{formatWorkflowDate(workflow.finishedAt)}</dd>
        </div>
      {/if}
      {#if workflow.sessionId}
        <div>
          <dt>{t('workflows.sessionId')}</dt>
          <dd>{String(workflow.sessionId)}</dd>
        </div>
      {/if}
    </dl>
  </header>

  {#if workflow.error}
    <div class="workflow-detail-error" role="alert">{String(workflow.error)}</div>
  {/if}

  {#if phases.length > 0}
    <section class="workflow-section">
      <h2>{t('workflows.phases')}</h2>
      <ol class="workflow-phase-list">
        {#each phases as phase, index (`${phase?.title || 'phase'}-${index}`)}
          <li class:current={phase?.title === workflow.currentPhase}>
            <span class="workflow-phase-marker" aria-hidden="true"></span>
            <div>
              <strong
                >{String(
                  phase?.title || t('workflows.phaseFallback', { index: index + 1 }),
                )}</strong
              >
              {#if phase?.detail}<p>{String(phase.detail)}</p>{/if}
            </div>
          </li>
        {/each}
      </ol>
    </section>
  {/if}

  {#if agents.length > 0}
    <section class="workflow-section">
      <h2>{t('workflows.agents')}</h2>
      <div class="workflow-agent-list">
        {#each agents as agent, index (index)}
          <div class="workflow-agent-row">
            <strong
              >{String(agent?.label || t('workflows.agentFallback', { index: index + 1 }))}</strong
            >
            {#if agent?.phase}<span>{String(agent.phase)}</span>{/if}
            {#if agent?.status}<WorkflowStatusChip status={String(agent.status)} />{/if}
            {#if agent?.model}<code>{String(agent.model)}</code>{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <WorkflowTranscriptViewer transcripts={detail?.transcripts} {agents} />

  {#if detail?.result != null}
    <section class="workflow-section">
      <h2>{t('workflows.result')}</h2>
      {#if typeof detail.result === 'string'}
        <div class="workflow-result-markdown markdown-content">{@html md(detail.result)}</div>
      {:else}
        <pre class="workflow-code-block"><code>{resultJSON}</code></pre>
      {/if}
    </section>
  {/if}

  {#if detail?.script != null}
    <details class="workflow-script">
      <summary>{t('workflows.script')}</summary>
      <pre class="workflow-code-block"><code>{String(detail.script)}</code></pre>
    </details>
  {/if}
</article>
