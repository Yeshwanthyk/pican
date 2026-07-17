<script>
  import { marked } from 'marked';
  import { configureSessionMarkdown, safeMarkedParse } from '../../session/render/markdown.js';
  import { escapeHtml } from '../../shared/escape.js';
  import { t } from '../../shared/i18n.js';
  import WorkflowStatusChip from './WorkflowStatusChip.svelte';
  import { workflowTranscriptGroups } from '../../workflows/workflows.js';

  let { transcripts = null, agents = [] } = $props();

  configureSessionMarkdown({ marked, hljs: null, escapeHtml });

  const groups = $derived(workflowTranscriptGroups(transcripts, agents));
  const md = (text) => safeMarkedParse(String(text || ''), { marked });
  const agentLabel = (group) =>
    String(group.agent?.label || t('workflows.agentFallback', { index: Number(group.index) + 1 }));
</script>

<!-- eslint-disable svelte/no-at-html-tags -- rendered through configured safeMarkedParse -->

<section class="workflow-section">
  <h2>{t('workflows.transcripts')}</h2>
  {#if groups.length === 0}
    <p class="workflow-muted">{t('workflows.noTranscripts')}</p>
  {:else}
    <div class="workflow-transcript-groups">
      {#each groups as group (group.index)}
        <details class="workflow-transcript-group">
          <summary>
            <span class="workflow-transcript-agent">{agentLabel(group)}</span>
            {#if group.agent?.phase}<span>{String(group.agent.phase)}</span>{/if}
            {#if group.agent?.status}<WorkflowStatusChip status={String(group.agent.status)} />{/if}
            <span>{t('workflows.entryCount', { count: group.entries.length })}</span>
          </summary>
          <div class="workflow-transcript-entries">
            {#each group.entries as entry, index (`${entry?.toolCallId || entry?.timestamp || 'entry'}-${index}`)}
              <article class="workflow-transcript-entry" data-role={entry?.role || 'unknown'}>
                <div class="workflow-entry-meta">
                  <span>{String(entry?.role || t('workflows.status.unknown'))}</span>
                  {#if entry?.name}<span>{String(entry.name)}</span>{/if}
                  {#if entry?.durationMs != null}<span>{Number(entry.durationMs)} ms</span>{/if}
                  {#if entry?.isError}<span class="workflow-entry-error"
                      >{t('workflows.error')}</span
                    >{/if}
                </div>
                {#if entry?.role === 'assistant'}
                  <div class="workflow-entry-markdown markdown-content">
                    {@html md(entry?.text)}
                  </div>
                {:else}
                  <div class="workflow-entry-text">{String(entry?.text || '')}</div>
                {/if}
              </article>
            {/each}
          </div>
        </details>
      {/each}
    </div>
  {/if}
</section>
