<script>
  import { marked } from 'marked';
  import { icon, ListTree } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import ToolOutput from './ToolOutput.svelte';

  let { result = null, resultText = '' } = $props();

  const details = $derived(
    result?.details && typeof result.details === 'object' ? result.details : null,
  );
  const phases = $derived(Array.isArray(details?.phases) ? details.phases.filter(Boolean) : []);
  const agents = $derived(
    Array.isArray(details?.agents)
      ? details.agents.filter(
          (agent) =>
            agent &&
            typeof agent === 'object' &&
            ['label', 'phase', 'status', 'model'].some((key) => agent[key] != null),
        )
      : [],
  );
  const currentPhaseIndex = $derived.by(() => {
    if (!details || phases.length === 0) return -1;
    if (typeof details.currentPhase === 'number') {
      return Math.max(0, Math.min(details.currentPhase, phases.length - 1));
    }
    return phases.findIndex(
      (phase) => phase.title === details.currentPhase || phase.id === details.currentPhase,
    );
  });

  const md = (text) => safeMarkedParse(text, { marked });
  const statusLabel = (status) => {
    const key = `session.${status}`;
    const translated = t(key);
    return translated === key ? status.replaceAll('_', ' ') : translated;
  };

  function phaseState(index) {
    if (details?.status === 'completed') return 'done';
    if (details?.status === 'running') {
      if (index < currentPhaseIndex) return 'done';
      if (index === currentPhaseIndex) return 'current';
    }
    return 'pending';
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div class="workflow-tool-card">
  <div class="workflow-header">
    <span class="workflow-icon">{@html icon(ListTree, { size: 15 })}</span>
    <span class="workflow-name"
      >{String(details?.name || details?.runId || t('session.workflow'))}</span
    >
    {#if details?.status}
      <span class="workflow-status status-{String(details.status)}">
        {statusLabel(String(details.status))}
      </span>
    {/if}
  </div>

  {#if phases.length > 0}
    <div class="workflow-phases">
      {#each phases as phase, index (`${phase.title ?? 'phase'}-${index}`)}
        <div class="workflow-phase phase-{phaseState(index)}">
          <span class="workflow-phase-marker"></span>
          <div>
            <div class="workflow-phase-title">{String(phase.title ?? '')}</div>
            {#if phase.detail}<div class="workflow-phase-detail">{String(phase.detail)}</div>{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if agents.length > 0}
    <div class="workflow-agents">
      {#each agents as agent, index (index)}
        <div class="workflow-agent-row">
          {#if agent.label}<span class="workflow-agent-label">{String(agent.label)}</span>{/if}
          {#if agent.phase}<span class="workflow-agent-meta">{String(agent.phase)}</span>{/if}
          {#if agent.status}
            <span class="workflow-status status-{String(agent.status)}">
              {statusLabel(String(agent.status))}
            </span>
          {/if}
          {#if agent.model}<span class="workflow-agent-meta">{String(agent.model)}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if details?.status === 'failed' && details.error}
    <div class="workflow-error">{String(details.error)}</div>
  {/if}

  {#if typeof details?.result === 'string' && details.result.trim()}
    <details class="extension-output-details">
      <summary>{t('session.showOutput')}</summary>
      <div class="markdown-content extension-markdown">{@html md(details.result)}</div>
    </details>
  {:else if !details && resultText.trim()}
    <ToolOutput text={resultText} maxLines={10} />
  {/if}
</div>

<style>
  .workflow-tool-card,
  .workflow-phases,
  .workflow-agents {
    display: grid;
    gap: 8px;
  }

  .workflow-header,
  .workflow-agent-row {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }

  .workflow-icon {
    display: inline-flex;
    color: var(--accent);
  }

  .workflow-name,
  .workflow-agent-label {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-weight: bold;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workflow-status {
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
  }

  .status-completed,
  .status-done {
    color: var(--success);
    border-color: var(--success);
  }

  .status-failed,
  .status-error {
    color: var(--error);
    border-color: var(--error);
  }

  .workflow-phase {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--muted);
  }

  .workflow-phase-marker {
    width: 7px;
    height: 7px;
    margin-top: 5px;
    flex: 0 0 auto;
    border: 1px solid currentColor;
    border-radius: 50%;
  }

  .phase-current {
    color: var(--accent);
  }

  .phase-current .workflow-phase-title {
    font-weight: bold;
  }

  .phase-done {
    color: var(--success);
  }

  .phase-done .workflow-phase-marker {
    background: currentColor;
  }

  .workflow-phase-detail,
  .workflow-agent-meta {
    color: var(--muted);
    font-size: 11px;
  }

  .workflow-error {
    color: var(--error);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
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
</style>
