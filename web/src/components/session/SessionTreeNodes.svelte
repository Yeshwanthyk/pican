<script lang="ts">
  // Renders the session tree node list + status line from the reactive
  // SessionDataModel. Live-safe (no SSE/fetch) → usable by live and export.
  // The {#each model.filteredNodes} block recomputes automatically whenever the
  // model's entries / filter / active path change.
  import { getSessionModel } from '../../session/session-context.js';
  import type { SessionDataModel } from '../../session/data/session-data.svelte.js';
  import { sessionEntryFromUnknown } from '../../session/data/session-types.js';
  import { buildTreePrefix } from '../../session/tree/session-tree.js';
  import type { FlatTreeNode } from '../../session/tree/session-tree.js';
  import { getTreeNodeDisplayHtml, escapeHtml } from '../../session/render/session-format.js';
  import { extractContent } from '../../session/tree/session-filter.js';
  import TreeNode from './TreeNode.svelte';

  // `model` falls back to context; tests/export inject it directly.
  // `onNavigate(id)` lets the host route a node click through its own navigator
  // (which renders content); when omitted we just move the model's view state.
  let {
    model = getSessionModel<SessionDataModel>(),
    onNavigate,
  }: { model?: SessionDataModel; onNavigate?: (id: string) => void } = $props();

  let containerEl = $state<HTMLDivElement | null>(null);

  const displayHtml = (flatNode: FlatTreeNode): string => {
    const entry = sessionEntryFromUnknown(flatNode.node.entry);
    if (!entry) return '';
    return getTreeNodeDisplayHtml(entry, flatNode.node.label, {
      extractContent,
      toolCallMap: model.toolCallMap,
      escapeHtmlImpl: (text) => escapeHtml(text, { documentImpl: document }),
    });
  };

  // Clicking a node navigates to the NEWEST leaf under it, while the clicked
  // node becomes the scroll target.
  function navigate(id: string): void {
    if (onNavigate) {
      onNavigate(id);
      return;
    }
    model.navigateTo(model.newestLeaf(id) || id, id);
  }

  // Keep the active node visible when the target changes. Depend on
  // currentTargetId so it re-runs on navigation.
  $effect(() => {
    void model.currentTargetId;
    if (!containerEl) return;
    const active = containerEl.querySelector<HTMLElement>('.tree-node.active');
    active?.scrollIntoView?.({ block: 'nearest' });
  });
</script>

<div class="tree-container" id="tree-container" bind:this={containerEl}>
  {#each model.filteredNodes as flatNode (flatNode.node.entry.id)}
    <TreeNode
      id={flatNode.node.entry.id}
      prefix={buildTreePrefix(flatNode)}
      displayHtml={displayHtml(flatNode)}
      onPath={model.activePathIds.has(flatNode.node.entry.id)}
      active={flatNode.node.entry.id === model.currentTargetId}
      onnavigate={navigate}
    />
  {/each}
</div>
<div class="tree-status" id="tree-status">
  {model.filteredNodes.length} / {model.flatNodes.length} entries
</div>
