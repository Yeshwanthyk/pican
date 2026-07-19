<script lang="ts">
  // One row in the session tree sidebar. Pure presentational + live-safe (no
  // SSE/fetch/live-only imports) so it can be used by BOTH the live app and the
  // static export. Keeps the established tree-node markup so existing CSS and
  // e2e selectors keep working:
  //
  //   <div class="tree-node [in-path] [active]" data-id=…>
  //     <span class="tree-prefix">…</span>
  //     <span class="tree-marker">• | ' '</span>
  //     <span class="tree-content">…html…</span>
  //   </div>
  //
  interface Props {
    readonly id: string;
    readonly prefix?: string;
    readonly displayHtml?: string;
    readonly onPath?: boolean;
    readonly active?: boolean;
    readonly onnavigate?: (id: string) => void;
  }

  let {
    id,
    prefix = '',
    displayHtml = '',
    onPath = false,
    active = false,
    onnavigate,
  }: Props = $props();

  function activate(): void {
    // Ignore clicks that are really the end of a text selection.
    if (typeof window !== 'undefined' && window.getSelection?.()?.toString()) return;
    onnavigate?.(id);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div
  class="tree-node"
  class:in-path={onPath}
  class:active
  data-id={id}
  role="treeitem"
  aria-selected={active}
  tabindex="-1"
  onclick={activate}
  onkeydown={onKeydown}
>
  <span class="tree-prefix">{prefix}</span><span class="tree-marker">{onPath ? '•' : ' '}</span
  ><span class="tree-content">{@html displayHtml}</span>
</div>
