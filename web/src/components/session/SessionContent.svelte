<script lang="ts">
  // The message pane: renders the active root→leaf path from the reactive model
  // as <SessionEntry> components, replacing the navigator's imperative #messages
  // build. Keyed by entry id so navigation and live reload add/update/remove
  // entries reactively. `afterRender(container)` runs after each (re)render to
  // re-apply toggle state, lazy-highlight pending code, and scroll — concerns the
  // imperative layer still owns. Shared by the live app + the static export.
  import { getSessionModel } from '../../session/session-context.js';
  import type { SessionEntry as SessionEntryData } from '../../session/data/session-types.js';
  import { t } from '../../shared/strings.js';
  import { groupToolRuns } from '../../session/render/group-tool-runs.js';
  import type { ToolRunRenderItem } from '../../session/render/group-tool-runs.js';
  import ActivityFold from './ActivityFold.svelte';
  import SessionEntry from './SessionEntry.svelte';

  interface ContentModel {
    readonly activePath: readonly SessionEntryData[];
    readonly entries?: readonly SessionEntryData[];
    readonly renderedTools?: unknown;
    readonly workerStatus?: { readonly state: string; readonly exitCode?: number };
  }

  interface Props {
    model?: ContentModel;
    afterRender?: ((container: HTMLElement) => void) | null;
    live?: boolean;
    modelLabel?: string;
    sessionId?: string;
  }

  let {
    model = getSessionModel<ContentModel>(),
    afterRender = null,
    live = false,
    modelLabel = '',
    sessionId = '',
  }: Props = $props();

  let containerEl = $state<HTMLDivElement | null>(null);
  const renderItems = $derived(groupToolRuns(model.activePath));

  function renderItemKey(item: ToolRunRenderItem, index: number): string {
    const entry = item.kind === 'group' ? item.entries[0] : item.entry;
    return entry?.id ?? `${item.kind}-${index}`;
  }

  // Re-run post-render side effects whenever the rendered path changes.
  $effect(() => {
    void renderItems;
    if (containerEl && typeof afterRender === 'function') {
      afterRender(containerEl);
    }
  });
</script>

<div id="messages-list" class="messages-list" bind:this={containerEl}>
  {#each renderItems as item, itemIndex (renderItemKey(item, itemIndex))}
    {#if item.kind === 'group'}
      <ActivityFold
        entries={item.entries}
        {model}
        toolCount={item.toolCount}
        durationSeconds={item.durationSeconds}
        hasEdits={item.hasEdits}
        status={item.status}
        startedAt={item.startedAt}
        {live}
        {sessionId}
      />
    {:else}
      <SessionEntry entry={item.entry} {model} {live} {modelLabel} {sessionId} />
    {/if}
  {/each}
  {#if model.workerStatus?.state === 'error'}
    <div class="plain-state plain-state--worker-down" role="status" aria-live="polite">
      <div class="plain-state-line plain-state-line--danger">
        {t('session.workerExited', { code: model.workerStatus.exitCode ?? '?' })}
      </div>
      <div class="plain-state-hint">{t('session.workerExitedHint')}</div>
    </div>
  {/if}
</div>
