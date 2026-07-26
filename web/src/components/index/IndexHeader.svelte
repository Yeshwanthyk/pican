<script lang="ts">
  import { icon, ArrowLeft, CalendarClock, MoreHorizontal } from '../../shared/icons.js';
  import { handleNavClick } from '../../shared/navigation.js';
  import { t } from '../../shared/strings.js';
  import type { SessionView } from '../../index/sessions.js';
  import { withBasePath } from '../../shared/base-path.js';

  interface Props {
    view?: SessionView;
    project?: string;
    projectName?: string;
    summaryLabel?: string;
    runningCount?: number;
    waitingCount?: number;
    menuOpen?: boolean;
    onSearch?: () => void;
    onNewSession?: () => void;
    onAddProject?: () => void;
    onToggleMenu?: () => void;
    onSchedules?: () => void;
  }

  let {
    view = 'home',
    project = '',
    projectName = '',
    summaryLabel = '',
    runningCount = 0,
    waitingCount = 0,
    menuOpen = false,
    onSearch = () => {},
    onNewSession = () => {},
    onAddProject = () => {},
    onToggleMenu = () => {},
    onSchedules = () => {},
  }: Props = $props();

  const scopes: ReadonlyArray<{
    readonly view: SessionView;
    readonly href: string;
    readonly key: string;
  }> = [
    { view: 'home', href: '/', key: 'index.scopeProjects' },
    { view: 'all', href: '/?view=all', key: 'index.scopeAll' },
    { view: 'archived', href: '/?view=archived', key: 'index.scopeArchived' },
  ];
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<header class="header">
  <div class="header-inner">
    <div class="header-identity">
      <img class="pi-logo-mark" src={withBasePath('/app-icon.png')} alt="" aria-hidden="true" />
      {#if project}
        <a
          class="project-back"
          href={withBasePath('/')}
          aria-label={t('index.backToProjects')}
          onclick={(event) => handleNavClick(event, '/')}>{@html icon(ArrowLeft, { size: 15 })}</a
        >
        <span class="header-project-name">{projectName}</span>
        <span class="header-project-path" title={project}>{project}</span>
      {:else}
        <span class="header-title-desktop">{t('index.title')}</span>
      {/if}
      <div class="workspace-stats" data-total-count>
        {#if summaryLabel}<span>{summaryLabel}</span>{/if}
        {#if runningCount > 0}
          <span class="workspace-stat-running"
            >{t('index.runningCount', { count: runningCount })}</span
          >
        {/if}
        {#if waitingCount > 0}
          <span class="workspace-stat-waiting"
            >{t('index.needsYouCount', { count: waitingCount })}</span
          >
        {/if}
        {#if runningCount === 0 && waitingCount === 0}<span>{t('index.allIdle')}</span>{/if}
      </div>
    </div>
    <div class="header-actions">
      {#if !project}
        <nav class="scope-toggle" aria-label={t('index.sessionScope')}>
          {#each scopes as scope}
            <a
              href={withBasePath(scope.href)}
              aria-current={view === scope.view ? 'page' : undefined}
              onclick={(event) => handleNavClick(event, scope.href)}>{t(scope.key)}</a
            >
          {/each}
        </nav>
        {#if view === 'home'}
          <button class="header-add-project" type="button" onclick={onAddProject}
            >{t('index.addProject')}</button
          >
        {/if}
      {/if}
      <button
        class="nav-search-btn"
        id="open-search"
        type="button"
        aria-haspopup="dialog"
        aria-controls="sessionPalette"
        onclick={onSearch}><span>{t('index.searchSessions')}</span><kbd>⌘K</kbd></button
      >
      <button class="header-new-session" type="button" onclick={onNewSession}
        ><span aria-hidden="true">+</span>{t('index.newSessionShort')}</button
      >
      <button
        type="button"
        class="schedules-nav-btn"
        data-schedules-btn
        title={t('schedules.navTitle')}
        onclick={onSchedules}
        ><span aria-hidden="true">{@html icon(CalendarClock, { size: 15 })}</span><span
          >{t('schedules.navTitle')}</span
        ></button
      >
      <button
        class="nav-menu-btn"
        id="web-menu-btn"
        type="button"
        aria-label={t('index.openMenu')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls="web-menu"
        onclick={(event) => {
          event.stopPropagation();
          onToggleMenu();
        }}>{@html icon(MoreHorizontal, { size: 17 })}</button
      >
    </div>
  </div>
</header>
