<script lang="ts">
  import { t } from '../../shared/strings.js';
  import {
    icon,
    SquarePen,
    FolderGit2,
    Layers,
    ListTree,
    Snowflake,
    Settings,
    Tag,
    Server,
  } from '../../shared/icons.js';
  import { openVersionModal } from '../../shared/version.js';
  import { handleNavClick } from '../../shared/navigation.js';
  import { withBasePath } from '../../shared/base-path.js';
  import type { NormalizedPeerHost } from '../../index/peers.js';

  interface Props {
    open?: boolean;
    onClose?: () => void;
    onNewSession?: () => void;
    onManageProjects?: () => void;
    peerHosts?: ReadonlyArray<NormalizedPeerHost>;
  }

  let {
    open = false,
    onClose = () => {},
    onNewSession = () => {},
    onManageProjects = () => {},
    peerHosts = [],
  }: Props = $props();

  const onlineCount = $derived(peerHosts.filter((host) => host.online).length);

  const scopes = [
    { href: '/', label: 'index.scopeProjects', icon: Layers },
    { href: '/?view=all', label: 'index.scopeAll', icon: ListTree },
    { href: '/?view=archived', label: 'index.scopeArchived', icon: Snowflake },
  ] as const;

  function handleBackdropClick(e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    onClose();
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<div
  id="web-menu-backdrop"
  class="mobile-command-backdrop"
  class:open
  style:display={open ? '' : 'none'}
  role="button"
  tabindex="0"
  aria-label={t('common.close')}
  onclick={handleBackdropClick}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') handleBackdropClick(e);
  }}
></div>
<div
  id="web-menu"
  class="web-menu"
  class:open
  role="menu"
  tabindex="-1"
  aria-labelledby="web-menu-btn"
  hidden={!open}
  onclick={(e) => e.stopPropagation()}
  onkeydown={() => {}}
>
  <div class="web-menu-section web-menu-scopes">
    {#each scopes as scope}
      <a
        class="web-menu-item"
        href={withBasePath(scope.href)}
        role="menuitem"
        onclick={(event) => {
          onClose();
          handleNavClick(event, scope.href);
        }}
        ><span class="menu-item-label">{@html icon(scope.icon, { size: 15 })}{t(scope.label)}</span
        ></a
      >
    {/each}
  </div>
  <div class="web-menu-section">
    <button
      class="web-menu-item"
      type="button"
      data-new-session-btn
      role="menuitem"
      onclick={() => {
        onClose();
        onNewSession();
      }}
      ><span class="menu-item-label"
        >{@html icon(SquarePen, { size: 15 })}{t('index.newSession')}</span
      ></button
    >
    <button
      class="web-menu-item"
      type="button"
      id="manage-projects-btn"
      data-manage-projects-btn
      role="menuitem"
      onclick={() => {
        onClose();
        onManageProjects();
      }}
      ><span class="menu-item-label"
        >{@html icon(FolderGit2, { size: 15 })}{t('index.addRemoveProjects')}</span
      ></button
    >
  </div>
  <div class="web-menu-section">
    <a
      class="web-menu-item"
      href={withBasePath('/settings')}
      role="menuitem"
      onclick={(event) => {
        onClose();
        handleNavClick(event, '/settings');
      }}
      ><span class="menu-item-label"
        >{@html icon(Settings, { size: 15 })}{t('common.settings')}</span
      ><kbd>⌘,</kbd></a
    >
    {#if peerHosts.length > 0}
      <a
        class="web-menu-item"
        href={withBasePath('/settings')}
        role="menuitem"
        onclick={(event) => {
          onClose();
          handleNavClick(event, '/settings');
        }}
        ><span class="menu-item-label">{@html icon(Server, { size: 15 })}{t('index.machines')}</span
        ><span class="machines-menu-count" data-machines-count
          >{t('index.machinesOnlineCount', { online: onlineCount, total: peerHosts.length })}</span
        ></a
      >
    {/if}
    <button
      class="web-menu-item"
      type="button"
      id="index-version-row"
      data-version-row
      role="menuitem"
      onclick={() => {
        onClose();
        openVersionModal();
      }}
      ><span class="menu-item-label">{@html icon(Tag, { size: 15 })}{t('common.version')}</span
      ><span class="version-status" data-version-status>…</span></button
    >
  </div>
</div>
