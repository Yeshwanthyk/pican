<script lang="ts">
  import type { Snippet } from 'svelte';
  import { handleNavClick } from '../../shared/navigation.js';
  import { withBasePath } from '../../shared/base-path.js';

  interface Props {
    id: string;
    title: string;
    count?: string;
    href?: string;
    actionLabel?: string;
    actionExpanded?: boolean;
    headingTitle?: string;
    level?: 2 | 3;
    bucket?: string;
    project?: string;
    spaced?: boolean;
    variant?: 'section' | 'project' | 'projects';
    onAction?: () => void;
    children?: Snippet;
  }

  let {
    id,
    title,
    count = '',
    href = '',
    actionLabel = '',
    actionExpanded,
    headingTitle = '',
    level = 2,
    bucket,
    project,
    spaced = false,
    variant = 'section',
    onAction,
    children,
  }: Props = $props();

  const headingId = $derived(`activity-group-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`);
  const resolvedHref = $derived(href ? withBasePath(href) : '');
</script>

<section
  class="activity-group"
  class:activity-group--spaced={spaced}
  class:activity-group--project={variant === 'project'}
  class:activity-group--projects={variant === 'projects'}
  aria-labelledby={headingId}
  data-bucket={bucket}
  data-project={project}
>
  <header class="activity-group-header">
    <svelte:element this={`h${level}`} id={headingId} class="activity-group-title">
      {#if resolvedHref}
        <a
          href={resolvedHref}
          title={headingTitle || title}
          onclick={(event) => handleNavClick(event, href)}>{title}</a
        >
      {:else}
        {title}
      {/if}
    </svelte:element>
    {#if actionLabel && resolvedHref}
      <a
        class="activity-group-action"
        href={resolvedHref}
        onclick={(event) => handleNavClick(event, href)}>{actionLabel}</a
      >
    {:else if actionLabel && onAction}
      <button
        class="activity-group-action"
        type="button"
        aria-expanded={actionExpanded}
        onclick={onAction}>{actionLabel}</button
      >
    {:else if count}
      <span class="activity-group-count">{count}</span>
    {/if}
  </header>
  <div class="activity-group-list">
    {@render children?.()}
  </div>
</section>
