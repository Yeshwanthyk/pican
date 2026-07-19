<script lang="ts">
  import { Marked } from 'marked';
  import { configureSessionMarkdown, safeMarkedParse } from '../../session/render/markdown';
  import { escapeHtml } from '../../shared/escape';
  import { formatRelativeTime } from '../../index/sessions';
  import { t } from '../../shared/strings';
  import TaskExecutionChip from './TaskExecutionChip.svelte';
  import type { NormalizedTask } from '../../tasks/tasks';
  import { settle, stringifyJson } from '../shared/ui-effect';
  import { describeError } from '../../lib/errors';

  let {
    task,
    project,
    fetchOutput,
  }: {
    task: NormalizedTask;
    project: string;
    fetchOutput: (project: string, taskId: string) => Promise<string>;
  } = $props();
  let expanded = $state(false);
  let output = $state('');
  let outputError = $state('');
  let outputLoading = $state(false);
  let outputLoaded = $state(false);

  const markdown = new Marked();
  configureSessionMarkdown({ marked: markdown, hljs: null, escapeHtml });

  const md = (text: unknown) => safeMarkedParse(String(text || ''), { marked: markdown });
  const metadata = $derived.by(() => {
    if (task.metadata == null) return '';
    return stringifyJson(task.metadata) || String(task.metadata);
  });
  const canShowOutput = $derived(
    !!task.execution?.outputFile ||
      ['completed', 'failed'].includes(String(task.execution?.status || '')),
  );

  async function loadOutput() {
    if (outputLoaded || outputLoading) return;
    outputLoading = true;
    outputError = '';
    const result = await settle(() => fetchOutput(project, task.id));
    if (result.ok) {
      output = result.value;
      outputLoaded = true;
    } else {
      outputError = describeError(result.error);
    }
    outputLoading = false;
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
