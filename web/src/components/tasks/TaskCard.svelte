<script>
  import { marked } from 'marked';
  import { configureSessionMarkdown, safeMarkedParse } from '../../session/render/markdown.js';
  import { escapeHtml } from '../../shared/escape.js';
  import { formatRelativeTime } from '../../index/sessions.js';
  import { t } from '../../shared/strings.js';
  import TaskExecutionChip from './TaskExecutionChip.svelte';

  let { task, project, fetchOutput } = $props();
  let expanded = $state(false);
  let output = $state('');
  let outputError = $state('');
  let outputLoading = $state(false);
  let outputLoaded = $state(false);

  configureSessionMarkdown({ marked, hljs: null, escapeHtml });

  const md = (text) => safeMarkedParse(String(text || ''), { marked });
  const metadata = $derived.by(() => {
    if (task.metadata == null) return '';
    try {
      return JSON.stringify(task.metadata, null, 2);
    } catch {
      return String(task.metadata);
    }
  });
  const canShowOutput = $derived(
    !!task.execution?.outputFile ||
      ['completed', 'failed'].includes(String(task.execution?.status || '')),
  );

  async function loadOutput() {
    if (outputLoaded || outputLoading) return;
    outputLoading = true;
    outputError = '';
    try {
      output = await fetchOutput(project, task.id);
      outputLoaded = true;
    } catch (error) {
      outputError = error.message || String(error);
    } finally {
      outputLoading = false;
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- rendered through configured safeMarkedParse -->

<article class="task-card" class:expanded>
  <button
    type="button"
    class="task-card-summary"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
  >
    <span class="task-card-heading">
      <span class="task-id">#{task.id}</span>
      <strong>{task.subject || t('tasks.untitled')}</strong>
    </span>
    <span class="task-card-meta">
      {#if task.owner}<span class="task-chip">{task.owner}</span>{/if}
      {#if task.agentType}<span class="task-chip task-chip-muted">{task.agentType}</span>{/if}
      {#if task.execution}<TaskExecutionChip status={task.execution.status} />{/if}
      {#if task.updatedAt}<time datetime={task.updatedAt}>{formatRelativeTime(task.updatedAt)}</time
        >{/if}
    </span>
    {#if task.blockedBy.length > 0}
      <span class="task-blocked-by"
        >{t('tasks.blockedBy', { ids: task.blockedBy.map((id) => `#${id}`).join(', ') })}</span
      >
    {/if}
  </button>

  {#if expanded}
    <div class="task-card-detail">
      {#if task.description}
        <div class="task-description markdown-content">{@html md(task.description)}</div>
      {/if}
      {#if metadata}
        <div class="task-detail-section">
          <h3>{t('tasks.metadata')}</h3>
          <pre><code>{metadata}</code></pre>
        </div>
      {/if}
      {#if canShowOutput}
        <details class="task-output" ontoggle={(event) => event.currentTarget.open && loadOutput()}>
          <summary>{t('tasks.showOutput')}</summary>
          {#if outputLoading}
            <p class="task-output-state">{t('tasks.loadingOutput')}</p>
          {:else if outputError}
            <p class="task-output-error" role="alert">{outputError}</p>
          {:else if outputLoaded}
            <pre><code>{output}</code></pre>
          {/if}
        </details>
      {/if}
    </div>
  {/if}
</article>
