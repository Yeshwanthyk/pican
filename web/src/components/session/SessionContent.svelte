<script>
  // The message pane: renders the active root→leaf path from the reactive model
  // as <SessionEntry> components, replacing the navigator's imperative #messages
  // build. Keyed by entry id so navigation and live reload add/update/remove
  // entries reactively. `afterRender(container)` runs after each (re)render to
  // re-apply toggle state, lazy-highlight pending code, and scroll — concerns the
  // imperative layer still owns. Shared by the live app + the static export.
  import { getSessionModel } from '../../session/session-context.js';
  import { formatToolRunBreakdown, groupToolRuns } from '../../session/render/group-tool-runs.js';
  import { t } from '../../shared/strings.js';
  import SessionEntry from './SessionEntry.svelte';

  let { model = getSessionModel(), afterRender = null, live = false } = $props();

  let containerEl = $state(null);
  const renderItems = $derived(groupToolRuns(model.activePath));

  // Re-run post-render side effects whenever the rendered path changes.
  $effect(() => {
    renderItems;
    if (containerEl && typeof afterRender === 'function') {
      afterRender(containerEl);
    }
  });
</script>

<div id="messages-list" class="messages-list" bind:this={containerEl}>
  {#each renderItems as item (item.kind === 'group' ? item.entries[0].id : item.entry.id)}
    {#if item.kind === 'group'}
      {@const breakdown = formatToolRunBreakdown(
        item.breakdown,
        t('session.moreToolNames', { count: item.breakdown.remaining }),
      )}
      <details class="tool-run-group {item.status}" open={item.status === 'error' || undefined}>
        <summary class="tool-run-group-summary">
          <span
            class="tool-run-group-status {item.status}"
            title={t(
              `session.${item.status === 'error' ? 'failed' : item.status === 'pending' ? 'running' : 'completed'}`,
            )}
            aria-hidden="true"
          ></span>
          <span class="sr-only">
            {t(
              `session.${item.status === 'error' ? 'failed' : item.status === 'pending' ? 'running' : 'completed'}`,
            )}
          </span>
          <span class="tool-run-group-count">
            {t('session.toolCalls', { count: item.toolCount })}
          </span>
          {#if breakdown}<span class="tool-run-group-breakdown">{breakdown}</span>{/if}
        </summary>
        <div class="tool-run-group-body">
          {#each item.entries as entry (entry.id)}
            <SessionEntry {entry} {model} {live} />
          {/each}
        </div>
      </details>
    {:else}
      <SessionEntry entry={item.entry} {model} {live} />
    {/if}
  {/each}
</div>
