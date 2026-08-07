<script lang="ts">
  import { marked } from 'marked';
  import type { SessionEntry as SessionEntryData } from '../../session/data/session-types.js';
  import { contentBlocksFromUnknown, isUnknownRecord } from '../../session/data/session-types.js';
  import {
    getToolResultLookup,
    type ToolResultLookupSource,
  } from '../../session/data/session-data.svelte.js';
  import { formatToolFoldSummary } from '../../session/render/session-format.js';
  import type { ToolRunStatus } from '../../session/render/group-tool-runs.js';
  import { t } from '../../shared/strings.js';
  import ToolCall from './ToolCall.svelte';

  interface ActivityModel extends ToolResultLookupSource {
    readonly renderedTools?: unknown;
  }

  let {
    entries,
    model,
    toolCount,
    durationSeconds,
    hasEdits,
    status,
    startedAt = '',
    live = false,
    sessionId = '',
  }: {
    entries: readonly SessionEntryData[];
    model?: ActivityModel | null;
    toolCount: number;
    durationSeconds: number;
    hasEdits: boolean;
    status: ToolRunStatus;
    startedAt?: string;
    live?: boolean;
    sessionId?: string;
  } = $props();

  const blocks = $derived(
    entries.flatMap((entry) =>
      entry.type === 'message' && entry.message?.role === 'assistant'
        ? contentBlocksFromUnknown(entry.message.content)
        : [],
    ),
  );
  const thinkingBlocks = $derived(
    blocks.filter((block) => block.type === 'thinking' && String(block.thinking ?? '').trim()),
  );
  const toolCalls = $derived(blocks.filter((block) => block.type === 'toolCall'));
  const activeTool = $derived(toolCalls.at(-1));
  const activeToolResult = $derived(
    getToolResultLookup(model, typeof activeTool?.id === 'string' ? activeTool.id : ''),
  );
  const activeCommand = $derived.by(() => {
    const name = String(activeTool?.name ?? t('session.activityTool'));
    const args = isUnknownRecord(activeTool?.arguments) ? activeTool.arguments : {};
    const details = activeToolResult?.details ?? null;
    const summary = formatToolFoldSummary(name, args, details ? { details } : null);
    return summary ? `${name} ${summary}` : name;
  });
  const isLiveTurn = $derived(live && status === 'pending');
  let now = $state(Date.now());
  const startedAtMs = $derived(Date.parse(startedAt));
  const elapsed = $derived(
    Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((now - startedAtMs) / 1000)) : 0,
  );
  const md = (text: string): string => marked.parse(text, { async: false });

  $effect(() => {
    if (!isLiveTurn) return;
    const timer = window.setInterval(() => (now = Date.now()), 1000);
    return () => window.clearInterval(timer);
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- thinking uses the shared Markdown renderer contract -->
<details
  class="activity-fold {status}"
  id={entries[0]?.id ? `entry-${entries[0].id}` : undefined}
  open={isLiveTurn || undefined}
>
  <summary class="activity-summary">
    {#if isLiveTurn}
      <span class="activity-running-dot" aria-hidden="true">●</span>
      <span class="activity-running">
        {t('session.activityRunning', {
          command: activeCommand,
          elapsed: t('session.activitySeconds', { count: elapsed }),
        })}
      </span>
      <span class="activity-summary-separator" aria-hidden="true">·</span>
    {/if}
    <span class="activity-summary-metrics">
      {t('session.activitySummary', {
        seconds: durationSeconds,
        count: toolCount,
        runs: toolCount === 1 ? t('session.activityRun') : t('session.activityRuns'),
      })}{#if hasEdits}{t('session.activityEdits')}{/if}
    </span>
  </summary>
  <div class="activity-body">
    {#each thinkingBlocks as block, index (`thinking-${index}`)}
      <div class="activity-thinking">
        <span class="activity-row-label">{t('session.activityThinking')}</span>
        <div class="activity-thinking-text markdown-content">
          {@html md(String(block.thinking ?? ''))}
        </div>
      </div>
    {/each}
    {#each toolCalls as call (call.id)}
      <ToolCall {call} {model} activity {live} {sessionId} />
    {/each}
  </div>
</details>
