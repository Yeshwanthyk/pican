<script lang="ts">
  // One assistant tool call. Dispatches on the tool name to a declarative
  // rendering of its arguments + (looked-up) result. Mirrors the former
  // renderToolCall(). {@html} is used only for pre-rendered (ANSI) custom-tool
  // HTML; everything else is escaped Svelte template. The result element keeps
  // the `entry-<resultId>` anchor so scroll still works.
  import { formatToolFoldSummary, shortenPath } from '../../session/render/session-format.js';
  import {
    contentBlocksFromUnknown,
    isUnknownRecord,
    type ContentBlock,
    type SessionMessage,
    type UnknownRecord,
  } from '../../session/data/session-types.js';
  import {
    getToolResultLookup,
    type ToolResultLookupSource,
  } from '../../session/data/session-data.svelte.js';
  import { t } from '../../shared/strings.js';
  import { parseWordsDiff } from '../../session/render/words-diff.js';
  import { getLanguageFromPath, str } from '../../session/render/entry-format.js';
  import ToolOutput, { toggleExpanded } from './ToolOutput.svelte';
  import AskQuestion from './AskQuestion.svelte';
  import TaskToolCard from './TaskToolCard.svelte';
  import SubagentToolCard from './SubagentToolCard.svelte';
  import WorkflowToolCard from './WorkflowToolCard.svelte';

  interface ToolCallModel extends ToolResultLookupSource {
    readonly renderedTools?: unknown;
  }

  interface ResultImage {
    readonly mimeType: string;
    readonly data: string;
  }

  interface RenderedTool {
    readonly callHtml?: string;
    readonly resultHtmlCollapsed?: string;
    readonly resultHtmlExpanded?: string;
  }

  let {
    call,
    model,
    activity = false,
    live = false,
    sessionId = '',
  }: {
    call: ContentBlock;
    model?: ToolCallModel | null;
    activity?: boolean;
    live?: boolean;
    sessionId?: string;
  } = $props();

  const toolName = $derived(typeof call.name === 'string' ? call.name : 'tool');
  const callId = $derived(typeof call.id === 'string' ? call.id : '');

  const resultLookup = $derived(getToolResultLookup(model, callId));
  const resultEntry = $derived(resultLookup?.entry ?? null);
  const result = $derived<SessionMessage | null>(resultLookup?.message ?? null);
  const resultDetails = $derived(resultLookup?.details ?? null);
  const statusClass = $derived(
    result ? (result.isRunning ? 'pending' : result.isError ? 'error' : 'success') : 'pending',
  );
  const args = $derived<UnknownRecord>(isUnknownRecord(call.arguments) ? call.arguments : {});
  const resultBlocks = $derived(contentBlocksFromUnknown(result?.content));

  const resultText = $derived(
    resultBlocks
      .filter((block) => block.type === 'text')
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n'),
  );
  const resultImages = $derived<ResultImage[]>(
    resultBlocks.flatMap((block) =>
      block.type === 'image' && typeof block.data === 'string'
        ? [
            {
              data: block.data,
              mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
            },
          ]
        : [],
    ),
  );
  const rendered = $derived.by((): RenderedTool | null => {
    if (!callId || !isUnknownRecord(model?.renderedTools)) return null;
    const candidate = model.renderedTools[callId];
    if (!isUnknownRecord(candidate)) return null;
    return {
      callHtml: typeof candidate.callHtml === 'string' ? candidate.callHtml : undefined,
      resultHtmlCollapsed:
        typeof candidate.resultHtmlCollapsed === 'string'
          ? candidate.resultHtmlCollapsed
          : undefined,
      resultHtmlExpanded:
        typeof candidate.resultHtmlExpanded === 'string' ? candidate.resultHtmlExpanded : undefined,
    };
  });
  const toolSummary = $derived(
    formatToolFoldSummary(toolName, args, resultDetails ? { details: resultDetails } : null),
  );
  const diffText = $derived(typeof resultDetails?.diff === 'string' ? resultDetails.diff : '');
  const parsedDiff = $derived(parseWordsDiff(diffText));
  const isLargeDiff = $derived(parsedDiff.changedLines > 8);
  const offset = $derived(typeof args.offset === 'number' ? args.offset : 1);
  const limit = $derived(typeof args.limit === 'number' ? args.limit : null);
  const toolResult = $derived(resultDetails ? { details: resultDetails } : null);

  // read/write/edit/ls share a file-path arg; compute it once.
  const filePath = $derived(str(args.file_path ?? args.path));
  const taskTools = new Set<string>([
    'TaskCreate',
    'TaskList',
    'TaskGet',
    'TaskUpdate',
    'TaskClaim',
    'TaskOutput',
    'TaskStop',
    'TaskExecute',
  ]);
  const subagentTools = new Set<string>([
    'subagent_spawn',
    'subagent_wait',
    'subagent_check',
    'subagent_cancel',
    'subagent_list',
  ]);
  let patchCopied = $state(false);

  async function copyPatch(): Promise<void> {
    if (!diffText) return;
    await navigator.clipboard.writeText(diffText);
    patchCopied = true;
    window.setTimeout(() => (patchCopied = false), 1200);
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<!--
  The .tool-call-collapsed sibling mirrors the .thinking-collapsed pattern:
  applyToggleStateToNode (web/src/session/ui/toggle-state.js) shows it whenever
  state.toolsVisible is false so an assistant message whose only content is a
  tool call doesn't render as a stranded timestamp.
-->
<div class="tool-call-collapsed">Tool: {toolName} ...</div>
<div
  class="tool-execution {statusClass}"
  class:activity-tool={activity}
  id={resultEntry ? `entry-${resultEntry.id}` : undefined}
>
  <details class="tool-fold" open={result?.isError || undefined}>
    <summary class="tool-fold-summary">
      <span class="tool-fold-status {statusClass}" aria-hidden="true"></span>
      <span class="tool-fold-name">{toolName}</span>
      {#if toolSummary}<span class="tool-fold-description">{toolSummary}</span>{/if}
      <span class="tool-fold-result {statusClass}">
        {t(
          `session.${statusClass === 'error' ? 'failed' : statusClass === 'pending' ? 'running' : 'completed'}`,
        )}
      </span>
    </summary>
    <div class="tool-fold-body">
      {#if toolName === 'bash'}
        {@const command = str(args.command)}
        <div class="tool-command">
          $ {#if command === null}<span class="tool-error">[invalid arg]</span>{:else}{command ||
              '...'}{/if}
        </div>
        {#if result && resultText.trim()}<ToolOutput text={resultText.trim()} maxLines={5} />{/if}
      {:else if toolName === 'read'}
        <div class="tool-header">
          <span class="tool-name">read</span>
          <span class="tool-path"
            >{#if filePath === null}<span class="tool-error">[invalid arg]</span
              >{:else}{shortenPath(
                filePath || '',
              )}{#if args.offset !== undefined || args.limit !== undefined}<span
                  class="line-numbers"
                  >:{offset}{limit !== null ? '-' + (offset + limit - 1) : ''}</span
                >{/if}{/if}</span
          >
        </div>
        {#if result}
          {#if resultImages.length > 0}<div class="tool-images">
              {#each resultImages as img, imgIndex (imgIndex)}<img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  class="tool-image"
                  alt=""
                />{/each}
            </div>{/if}
          {#if resultText}<ToolOutput
              text={resultText}
              maxLines={10}
              lang={filePath ? getLanguageFromPath(filePath) : null}
            />{/if}
        {/if}
      {:else if toolName === 'write'}
        {@const content = str(args.content)}
        {@const lineCount = content ? content.split('\n').length : 0}
        <div class="tool-header">
          <span class="tool-name">write</span>
          <span class="tool-path"
            >{#if filePath === null}<span class="tool-error">[invalid arg]</span
              >{:else}{shortenPath(filePath || '')}{/if}</span
          >{#if content !== null && content && lineCount > 10}
            <span class="line-count">({lineCount} lines)</span>{/if}
        </div>
        {#if content === null}<div class="tool-error">
            [invalid content arg - expected string]
          </div>{:else if content}<ToolOutput
            text={content}
            maxLines={10}
            lang={filePath ? getLanguageFromPath(filePath) : null}
          />{/if}
        {#if result && resultText.trim()}<div class="tool-output">
            <div>{resultText.trim()}</div>
          </div>{/if}
      {:else if toolName === 'edit'}
        {#if diffText}
          <details
            class="tool-diff-sheet"
            class:large={isLargeDiff}
            open={!isLargeDiff || undefined}
          >
            <summary class="tool-diff-chip">
              <span class="tool-diff-file">{shortenPath(filePath || '')}</span>
              <span class="tool-diff-counts">
                +{parsedDiff.additions} −{parsedDiff.deletions}
              </span>
              {#if isLargeDiff}<span aria-hidden="true">▸</span>{/if}
            </summary>
            <div class="tool-diff">
              <div class="tool-diff-rows">
                {#each parsedDiff.rows as row, rowIndex (rowIndex)}
                  <div class="tool-diff-row diff-{row.kind}">
                    <span class="diff-line-number">{row.oldLine ?? ''}</span>
                    <span class="diff-line-number">{row.newLine ?? ''}</span>
                    <span class="diff-marker">{row.marker}</span>
                    <code
                      >{#each row.segments as segment, segmentIndex (segmentIndex)}<span
                          class:diff-word-changed={segment.changed}
                          >{segment.text.replace(/\t/g, '   ')}</span
                        >{/each}</code
                    >
                  </div>
                {/each}
              </div>
              <div class="tool-diff-actions">
                {#if live && sessionId}<button
                    type="button"
                    class="open-full-diff-btn"
                    data-session-id={sessionId}>{t('session.openFullDiff')}</button
                  >{/if}
                <button type="button" onclick={copyPatch}>
                  {patchCopied ? t('common.copied') : t('session.copyPatch')}
                </button>
              </div>
            </div>
          </details>
        {:else if result && resultText.trim()}<div class="tool-output">
            <pre>{resultText.trim()}</pre>
          </div>{/if}
      {:else if toolName === 'ls'}
        <div class="tool-header">
          <span class="tool-name">ls</span>
          <span class="tool-path"
            >{#if str(args.path) === null}<span class="tool-error">[invalid arg]</span
              >{:else}{shortenPath(str(args.path) || '.')}{/if}{#if args.limit !== undefined}
              <span class="line-count">(limit {args.limit})</span>{/if}</span
          >
        </div>
        {#if result && resultText.trim()}<ToolOutput text={resultText.trim()} maxLines={20} />{/if}
      {:else if toolName === 'ask_user_question' || toolName === 'pican_ask_user_question'}
        <AskQuestion {args} {result} />
      {:else if taskTools.has(toolName)}
        <TaskToolCard name={toolName} {args} {resultText} />
      {:else if subagentTools.has(toolName)}
        <SubagentToolCard name={toolName} result={toolResult} {resultText} />
      {:else if toolName === 'workflow'}
        <WorkflowToolCard result={toolResult} {resultText} />
      {:else if rendered && (rendered.callHtml || rendered.resultHtmlCollapsed || rendered.resultHtmlExpanded)}
        {#if rendered.callHtml}<div class="tool-header ansi-rendered">
            {@html rendered.callHtml}
          </div>{:else}<div class="tool-header">
            <span class="tool-name">{toolName}</span>
          </div>{/if}
        {#if rendered.resultHtmlCollapsed && rendered.resultHtmlExpanded && rendered.resultHtmlCollapsed !== rendered.resultHtmlExpanded}
          <div
            class="tool-output expandable ansi-rendered"
            onclick={toggleExpanded}
            role="presentation"
          >
            <div class="output-preview">{@html rendered.resultHtmlCollapsed}</div>
            <div class="output-full">{@html rendered.resultHtmlExpanded}</div>
          </div>
        {:else if rendered.resultHtmlExpanded}
          <div class="tool-output ansi-rendered">{@html rendered.resultHtmlExpanded}</div>
        {:else if result && resultText}<ToolOutput text={resultText} maxLines={10} />{/if}
      {:else}
        <div class="tool-header"><span class="tool-name">{toolName}</span></div>
        <div class="tool-output"><pre>{JSON.stringify(args, null, 2)}</pre></div>
        {#if result && resultText}<ToolOutput text={resultText} maxLines={10} />{/if}
      {/if}
    </div>
  </details>
</div>
