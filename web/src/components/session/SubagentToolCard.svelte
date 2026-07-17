<script>
  import { marked } from 'marked';
  import { icon, Layers } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import ToolOutput from './ToolOutput.svelte';

  let { name, result = null, resultText = '' } = $props();

  const details = $derived(
    result?.details && typeof result.details === 'object' ? result.details : null,
  );
  const rows = $derived.by(() => {
    if (!details) return [];
    if (name === 'subagent_spawn' && details.id) return [details];
    if (name === 'subagent_check' && details.id) return [details];
    if (name === 'subagent_list') {
      return Array.isArray(details.subagents) ? details.subagents.filter(Boolean) : [];
    }
    if (name === 'subagent_wait' || name === 'subagent_cancel') {
      const results = Array.isArray(details.results) ? details.results.filter(Boolean) : [];
      if (name === 'subagent_wait' && Array.isArray(details.pending)) {
        results.push(
          ...details.pending
            .filter((id) => id !== undefined && id !== null)
            .map((id) => ({ id, status: 'running' })),
        );
      }
      return results;
    }
    return [];
  });
  const hasStructuredDetails = $derived(rows.length > 0);

  const md = (text) => safeMarkedParse(text, { marked });
  const statusLabel = (status) => {
    const key = `session.${status}`;
    const translated = t(key);
    return translated === key ? status.replaceAll('_', ' ') : translated;
  };
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div class="subagent-tool-card">
  <div class="subagent-tool-header">
    <span class="subagent-tool-icon">{@html icon(Layers, { size: 15 })}</span>
    <span>{t('session.subagents')}</span>
    <span class="subagent-tool-name">{name}</span>
  </div>

  {#if hasStructuredDetails}
    <div class="subagent-rows">
      {#each rows as agent, index (`${agent.id ?? 'agent'}-${index}`)}
        <div class="subagent-row">
          <span class="subagent-id">{String(agent.id ?? '')}</span>
          {#if agent.title}<span class="subagent-title">{String(agent.title)}</span>{/if}
          {#if agent.harness}<span class="subagent-harness">{String(agent.harness)}</span>{/if}
          {#if agent.status}
            <span class="subagent-status status-{String(agent.status)}">
              {statusLabel(String(agent.status))}
            </span>
          {/if}
          {#if agent.turns !== undefined}
            <span class="subagent-turns">{t('session.turns', { count: agent.turns })}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if name === 'subagent_wait' && resultText.trim()}
    <details class="extension-output-details">
      <summary>{t('session.showOutput')}</summary>
      <div class="markdown-content extension-markdown">{@html md(resultText)}</div>
    </details>
  {:else if resultText.trim() && !hasStructuredDetails}
    <ToolOutput text={resultText} maxLines={10} />
  {/if}
</div>

<style>
  .subagent-tool-card,
  .subagent-rows {
    display: grid;
    gap: 8px;
  }

  .subagent-tool-header,
  .subagent-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .subagent-tool-header {
    color: var(--text);
    font-weight: bold;
  }

  .subagent-tool-icon {
    display: inline-flex;
    color: var(--accent);
  }

  .subagent-tool-name,
  .subagent-id,
  .subagent-turns {
    color: var(--muted);
    font-size: 11px;
  }

  .subagent-id {
    flex: 0 0 auto;
    font-family: var(--font-code);
  }

  .subagent-title {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subagent-harness,
  .subagent-status {
    flex: 0 0 auto;
    padding: 1px 6px;
    border: 1px solid var(--dim);
    border-radius: 999px;
    color: var(--muted);
    font-size: 10px;
    line-height: 1.35;
  }

  .status-running {
    color: var(--accent);
    border-color: var(--accent);
    animation: subagent-pulse 1.6s ease-in-out infinite;
  }

  .status-done {
    color: var(--success);
    border-color: var(--success);
  }

  .status-error {
    color: var(--error);
    border-color: var(--error);
  }

  .extension-output-details {
    color: var(--toolOutput);
  }

  .extension-output-details summary {
    width: fit-content;
    cursor: pointer;
    color: var(--muted);
    font-size: 11px;
  }

  .extension-output-details summary:hover {
    color: var(--text);
  }

  .extension-markdown {
    margin-top: 8px;
    color: var(--toolOutput);
  }

  @keyframes subagent-pulse {
    50% {
      opacity: 0.55;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .status-running {
      animation: none;
    }
  }
</style>
