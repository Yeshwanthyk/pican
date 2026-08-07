<script lang="ts">
  // One conversation entry in the message pane, rendered declaratively (the
  // decomposition of the former renderEntry()). {@html} is used only for markdown
  // (safeMarkedParse) — everything else is escaped Svelte template. The wrapper
  // keeps its `entry-<id>` anchor so scroll/toggle + deep links survive.
  // Shared by the live app and the static export (model passed as a prop).
  import { onDestroy } from 'svelte';
  import { Schema } from 'effect';
  import { marked } from 'marked';
  import { icon, Check, CircleCheck, CircleX, Copy, GitFork, Link2 } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';
  import { createEntryMarkdownCache } from '../../session/render/entry-markdown-cache.js';
  import { formatTimestamp } from '../../session/render/entry-format.js';
  import {
    contentBlocksFromUnknown,
    type ContentBlock,
    type SessionEntry as SessionEntryData,
  } from '../../session/data/session-types.js';
  import {
    getToolResultLookup,
    type ToolResultLookupSource,
  } from '../../session/data/session-data.svelte.js';
  import ToolOutput from './ToolOutput.svelte';
  import ActivityFold from './ActivityFold.svelte';

  // `live` (passed from <SessionContent>) gates the fork button, which needs the
  // chat composer; message-copy and copy-link are available in both the live app
  // and static export through environment-specific clipboard adapters.
  interface EntryModel extends ToolResultLookupSource {
    readonly renderedTools?: unknown;
  }

  interface ImageBlock {
    readonly mimeType: string;
    readonly data: string;
  }

  let {
    entry,
    model = null,
    live = false,
    modelLabel = '',
    sessionId = '',
    canFork = true,
    copyText = async () => false,
  }: {
    entry: SessionEntryData;
    model?: EntryModel | null;
    live?: boolean;
    modelLabel?: string;
    sessionId?: string;
    canFork?: boolean;
    copyText?: (text: string) => Promise<boolean>;
  } = $props();

  let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  const ts = $derived(formatTimestamp(entry.timestamp));
  const entryId = $derived(entry.id ?? '');
  const md = createEntryMarkdownCache(
    (text) => marked.parse(text, { async: false }),
    () => marked.defaults,
  );
  const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
  const displayUnknown = (value: unknown): string =>
    typeof value === 'string' ? value : encodeJson(value);
  const blockText = (block: ContentBlock): string =>
    typeof block.text === 'string' ? block.text : '';
  const blockThinking = (block: ContentBlock): string =>
    typeof block.thinking === 'string' ? block.thinking : '';
  const imageBlocks = (content: unknown): ImageBlock[] =>
    contentBlocksFromUnknown(content).flatMap((block) =>
      block.type === 'image' && typeof block.data === 'string'
        ? [
            {
              data: block.data,
              mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
            },
          ]
        : [],
    );

  const msg = $derived(entry.type === 'message' ? (entry.message ?? null) : null);
  const messageBlocks = $derived(contentBlocksFromUnknown(msg?.content));
  const userText = $derived.by(() => {
    if (!msg || msg.role !== 'user') return '';
    const c = msg.content;
    return typeof c === 'string'
      ? c
      : contentBlocksFromUnknown(c)
          .filter((b) => b.type === 'text')
          .map(blockText)
          .join('\n');
  });
  const userImages = $derived(imageBlocks(msg?.content));
  const messageCopyText = $derived.by(() => {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return '';
    if (typeof msg.content === 'string') return msg.content;
    return contentBlocksFromUnknown(msg.content)
      .filter((block) => block.type === 'text' && blockText(block))
      .map(blockText)
      .join('\n\n');
  });
  const assistantToolCalls = $derived(messageBlocks.filter((block) => block.type === 'toolCall'));
  const assistantThinking = $derived(
    messageBlocks.filter(
      (block) => block.type === 'thinking' && blockThinking(block).trim().length > 0,
    ),
  );
  const hasAssistantActivity = $derived(
    assistantToolCalls.length > 0 || assistantThinking.length > 0,
  );
  const assistantHasText = $derived(
    messageBlocks.some((block) => block.type === 'text' && blockText(block).trim()),
  );
  const activityResults = $derived(
    assistantToolCalls.flatMap((call) => {
      const result = getToolResultLookup(model, typeof call.id === 'string' ? call.id : '');
      return result ? [result] : [];
    }),
  );
  const embeddedActivityResultCount = $derived(
    activityResults.reduce((count, result) => count + result.resultCount, 0),
  );
  const embeddedActivityStatus = $derived(
    activityResults.some((result) => result.hasError)
      ? 'error'
      : assistantToolCalls.length > embeddedActivityResultCount
        ? 'pending'
        : 'success',
  );
  const embeddedActivityHasEdits = $derived(activityResults.some((result) => result.hasEdits));
  const assistantName = $derived(
    String(msg?.model || msg?.provider || modelLabel || '').trim() || t('session.assistant'),
  );
  const copyLabel = $derived(
    copyState === 'copied'
      ? t('common.copied')
      : copyState === 'failed'
        ? t('common.copyFailed')
        : t('session.copyMessage'),
  );

  async function copyMessage(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (!messageCopyText) return;
    const copied = await copyText(messageCopyText);
    copyState = copied ? 'copied' : 'failed';
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyState = 'idle';
      copyResetTimer = null;
    }, 1500);
  }

  onDestroy(() => {
    if (copyResetTimer) clearTimeout(copyResetTimer);
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

{#snippet actions(id: string)}
  {#if live && canFork}<button
      class="fork-btn"
      data-entry-id={id}
      title={t('session.forkFromMessage')}
      aria-label={t('session.forkFromMessage')}>{@html icon(GitFork, { size: 16 })}</button
    >{/if}
  {#if messageCopyText}<button
      class:copied={copyState === 'copied'}
      class:copy-failed={copyState === 'failed'}
      class="copy-message-btn"
      type="button"
      title={copyLabel}
      aria-label={copyLabel}
      onclick={copyMessage}
      >{@html icon(copyState === 'copied' ? Check : copyState === 'failed' ? CircleX : Copy, {
        size: 16,
      })}<span class="sr-only" aria-live="polite">{copyState === 'idle' ? '' : copyLabel}</span
      ></button
    >{/if}
  <button
    class="copy-link-btn"
    data-entry-id={id}
    title={t('session.copyMessageLink')}
    aria-label={t('session.copyMessageLink')}>{@html icon(Link2, { size: 16 })}</button
  >
{/snippet}
{#snippet timestamp()}{#if ts}<div class="message-timestamp">{ts}</div>{/if}{/snippet}

{#if msg && msg.role === 'user'}
  <div class="user-message" id={`entry-${entryId}`}>
    {@render actions(entryId)}{@render timestamp()}
    <div class="message-who user-who">
      {t('session.you')}{#if ts}<span aria-hidden="true"> · </span>{ts}{/if}
    </div>
    {#if userImages.length > 0}<div class="message-images">
        {#each userImages as img, imgIndex (imgIndex)}<img
            src={`data:${img.mimeType};base64,${img.data}`}
            class="message-image"
            alt=""
          />{/each}
      </div>{/if}
    {#if userText.trim()}<div class="markdown-content">
        {@html md(entry, 'user-text', userText)}
      </div>{/if}
  </div>
{:else if msg && msg.role === 'assistant'}
  <div class="assistant-message" id={`entry-${entryId}`}>
    {@render actions(entryId)}{@render timestamp()}
    {#if assistantHasText}<div class="message-who assistant-who">{assistantName}</div>{/if}
    {#if hasAssistantActivity}
      <ActivityFold
        entries={[entry]}
        {model}
        toolCount={assistantToolCalls.length}
        durationSeconds={0}
        hasEdits={embeddedActivityHasEdits}
        status={embeddedActivityStatus}
        startedAt={entry.timestamp ?? ''}
        {live}
        {sessionId}
      />
    {/if}
    {#each messageBlocks as block, blockIndex (blockIndex)}
      {#if block.type === 'text' && blockText(block).trim()}<div
          class="assistant-text markdown-content"
        >
          {@html md(entry, `assistant-text-${blockIndex}`, blockText(block))}
        </div>{/if}
    {/each}
    {#if msg.stopReason === 'aborted'}<div class="error-text">
        Aborted
      </div>{:else if msg.stopReason === 'error'}<div class="error-text">
        Error: {msg.errorMessage || 'Unknown error'}
      </div>{/if}
  </div>
{:else if msg && msg.role === 'bashExecution'}
  <div
    class="tool-execution {msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null)
      ? 'error'
      : 'success'}"
    id={`entry-${entryId}`}
  >
    {@render timestamp()}
    <div class="tool-command">$ {msg.command}</div>
    {#if msg.output}<ToolOutput text={msg.output} maxLines={10} />{/if}
    {#if msg.cancelled}<div style="color: var(--warning)">
        (cancelled)
      </div>{:else if msg.exitCode !== 0 && msg.exitCode !== null}<div style="color: var(--error)">
        (exit {msg.exitCode})
      </div>{/if}
  </div>
{:else if entry.type === 'model_change' && !entry.implicit}
  <div class="model-change" id={`entry-${entryId}`}>
    {@render timestamp()}Switched to model:
    <span class="model-name">{entry.provider}/{entry.modelId}</span>
  </div>
{:else if entry.type === 'compaction'}
  <div
    class="compaction"
    id={`entry-${entryId}`}
    onclick={(e) => {
      if (window.getSelection?.()?.toString()) return;
      e.currentTarget.classList.toggle('expanded');
    }}
    role="presentation"
  >
    <div class="compaction-label">[compaction]</div>
    <div class="compaction-collapsed">
      Compacted from {(entry.tokensBefore ?? 0).toLocaleString()} tokens
    </div>
    <div class="compaction-content">
      <strong>Compacted from {(entry.tokensBefore ?? 0).toLocaleString()} tokens</strong
      >{'\n\n'}{entry.summary}
    </div>
  </div>
{:else if entry.type === 'branch_summary'}
  <div class="branch-summary" id={`entry-${entryId}`}>
    {@render timestamp()}
    <div class="branch-summary-header">Branch Summary</div>
    <div class="markdown-content">{@html md(entry, 'branch-summary', entry.summary ?? '')}</div>
  </div>
{:else if entry?.type === 'custom_message' && entry.display}
  {#if entry.customType === 'subagent-result'}
    {@const subagentStatus = entry.details?.status === 'error' ? 'error' : 'done'}
    <div class="hook-message subagent-result-card {subagentStatus}" id={`entry-${entryId}`}>
      {@render timestamp()}
      <div class="subagent-result-header">
        <span class="subagent-result-icon">
          {@html icon(subagentStatus === 'error' ? CircleX : CircleCheck, { size: 15 })}
        </span>
        <span
          >{t('session.subagentResult', {
            id: entry.details?.id ?? '',
            title: entry.details?.title ?? '',
          })}</span
        >
      </div>
      <details class="subagent-result-details">
        <summary>{t('session.showOutput')}</summary>
        <div class="markdown-content subagent-result-content">
          {@html md(entry, 'custom-content', displayUnknown(entry.content))}
        </div>
      </details>
    </div>
  {:else}
    <div class="hook-message" id={`entry-${entryId}`}>
      {@render timestamp()}
      <div class="hook-type">[{entry.customType}]</div>
      <div class="markdown-content">
        {@html md(entry, 'custom-content', displayUnknown(entry.content))}
      </div>
    </div>
  {/if}
{/if}

<style>
  .subagent-result-card {
    display: grid;
    gap: 8px;
  }

  .subagent-result-header {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--text);
    font-weight: bold;
  }

  .subagent-result-icon {
    display: inline-flex;
  }

  .subagent-result-card.done .subagent-result-icon {
    color: var(--success);
  }

  .subagent-result-card.error .subagent-result-icon {
    color: var(--error);
  }

  .subagent-result-details summary {
    width: fit-content;
    cursor: pointer;
    color: var(--muted);
    font-size: 11px;
  }

  .subagent-result-details summary:hover {
    color: var(--text);
  }

  .subagent-result-content {
    margin-top: 8px;
  }
</style>
