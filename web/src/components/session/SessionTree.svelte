<script>
  // On-demand conversation-branch tree, opened as a FullScreenSheet overlay
  // (centered dialog on desktop, bottom sheet on mobile) — same pattern as
  // DiffModal. Replaces the old persistent docked `<aside id="sidebar">`.
  import FullScreenSheet from './FullScreenSheet.svelte';
  import { t } from '../../shared/strings.js';
  import { getSessionModel } from '../../session/session-context.js';
  import { getSessionRuntime } from '../../session/session-runtime-context.js';
  import { closeTree } from '../../session/session-modals.svelte.js';
  import SessionTreeNodes from './SessionTreeNodes.svelte';

  let { open = $bindable(false) } = $props();

  const model = getSessionModel();

  // Route a tree-node click through the shared navigator so message content
  // scrolls after the reactive render. Navigate to the newest leaf under the
  // clicked node, with the clicked node as the scroll target, and close the
  // overlay — on every viewport, since the tree is now an on-demand sheet
  // rather than a persistent panel.
  function onNavigate(id) {
    const leaf = model?.newestLeaf(id) || id;
    const navigateTo = getSessionRuntime().navigateTo;
    navigateTo?.(leaf, 'target', id);
    closeTree();
  }
</script>

<FullScreenSheet
  bind:open
  title={t('menu.tree')}
  backdropClass="tree-sheet-backdrop"
  panelClass="tree-sheet-panel"
  bodyClass="tree-sheet-body"
>
  <div class="sidebar-header">
    <div class="sidebar-controls">
      <input type="text" class="sidebar-search" id="tree-search" placeholder={t('common.search')} />
    </div>
    <div class="sidebar-filters">
      <button
        class="filter-btn active"
        data-filter="default"
        title={t('session.filterDefaultTitle')}>{t('session.filterDefault')}</button
      ><button class="filter-btn" data-filter="no-tools" title={t('session.filterNoToolsTitle')}
        >{t('session.filterNoTools')}</button
      ><button class="filter-btn" data-filter="user-only" title={t('session.filterUserTitle')}
        >{t('session.filterUser')}</button
      ><button class="filter-btn" data-filter="labeled-only" title={t('session.filterLabeledTitle')}
        >{t('session.filterLabeled')}</button
      ><button class="filter-btn" data-filter="all" title={t('session.filterAllTitle')}
        >{t('session.filterAll')}</button
      >
    </div>
  </div>
  {#if model}<SessionTreeNodes {model} {onNavigate} />{:else}<div
      class="tree-container"
      id="tree-container"
    ></div>
    <div class="tree-status" id="tree-status"></div>{/if}
</FullScreenSheet>

<!-- Styles live in internal/ui/embedded/styles/session.css (the app loads global
     stylesheets, not Svelte-scoped <style> blocks — see ModelUsageModal). -->
