<script>
  import { icon, ListChecks } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';
  import { parseTaskLines } from '../../session/render/task-tool.js';

  let { name, args = {}, resultText = '' } = $props();

  const parsed = $derived(parseTaskLines(resultText));
  const passthrough = $derived(parsed.passthroughLines.join('\n'));
  const hasPassthrough = $derived(parsed.passthroughLines.some((line) => line.length > 0));
  const argumentValue = $derived.by(() => {
    if (name === 'TaskCreate') return args.subject;
    if (name === 'TaskExecute') return args.task_ids;
    if (['TaskUpdate', 'TaskGet', 'TaskClaim', 'TaskOutput', 'TaskStop'].includes(name)) {
      return args.taskId ?? args.task_id;
    }
    return null;
  });

  function displayValue(value) {
    if (Array.isArray(value)) return value.join(', ');
    if (value === undefined || value === null) return '';
    return String(value);
  }

  function statusLabel(status) {
    if (status === 'in_progress') return t('session.inProgress');
    return t(`session.${status}`);
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<div class="extension-tool-card task-tool-card">
  <div class="extension-tool-header">
    <span class="extension-tool-icon">{@html icon(ListChecks, { size: 15 })}</span>
    <span>{t('session.tasks')}</span>
    <span class="extension-tool-name">{name}</span>
  </div>

  {#if displayValue(argumentValue)}
    <div class="extension-tool-focus">{displayValue(argumentValue)}</div>
  {/if}

  {#if parsed.tasks.length > 0}
    <div class="extension-tool-rows">
      {#each parsed.tasks as task (`${task.id}-${task.status}-${task.subject}`)}
        <div class="extension-tool-row task-tool-row">
          <span class="extension-tool-id">#{task.id}</span>
          <span class="extension-status status-{task.status}">{statusLabel(task.status)}</span>
          <span class="extension-tool-title">{task.subject}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if hasPassthrough}<pre class="extension-tool-plain">{passthrough}</pre>{/if}
</div>

<style>
  .extension-tool-card {
    display: grid;
    gap: 8px;
  }

  .extension-tool-header,
  .extension-tool-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .extension-tool-header {
    color: var(--text);
    font-weight: bold;
  }

  .extension-tool-icon {
    display: inline-flex;
    color: var(--accent);
  }

  .extension-tool-name,
  .extension-tool-id {
    color: var(--muted);
    font-size: 11px;
  }

  .extension-tool-focus {
    color: var(--text);
    font-weight: bold;
    overflow-wrap: anywhere;
  }

  .extension-tool-rows {
    display: grid;
    gap: 5px;
  }

  .task-tool-row {
    align-items: baseline;
  }

  .extension-tool-id {
    flex: 0 0 auto;
    font-family: var(--font-code);
  }

  .extension-tool-title {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .extension-status {
    flex: 0 0 auto;
    padding: 1px 6px;
    border: 1px solid var(--dim);
    border-radius: 999px;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.35;
  }

  .status-in_progress {
    color: var(--accent);
    border-color: var(--accent);
  }

  .status-completed {
    color: var(--success);
    border-color: var(--success);
  }

  .extension-tool-plain {
    margin: 0;
    color: var(--toolOutput);
    font: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
