<script lang="ts">
  import { icon, MoreHorizontal, CalendarClock } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';

  type Layout = 'timeline' | 'projects';

  interface Props {
    layout?: Layout;
    totalSessionsLabel?: string;
    runningCount?: number;
    waitingCount?: number;
    menuOpen?: boolean;
    onSearch?: () => void;
    onNewSession?: () => void;
    onToggleMenu?: () => void;
    onLayoutChange?: (layout: Layout) => void;
    onSchedules?: () => void;
  }

  let {
    layout = 'timeline',
    totalSessionsLabel = t('index.sessionsCount', { count: 0 }),
    runningCount = 0,
    waitingCount = 0,
    menuOpen = false,
    onSearch = () => {},
    onNewSession = () => {},
    onToggleMenu = () => {},
    onLayoutChange = () => {},
    onSchedules = () => {},
  }: Props = $props();
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<header class="header">
  <div class="header-inner">
    <div class="header-identity">
      <img class="pi-logo-mark" src="/app-icon.png" alt="" aria-hidden="true" />
      <span class="header-title-desktop">{t('index.title')}</span>
      <span class="header-title-mobile">{t('index.mobileTitle')}</span>
      <div class="workspace-stats" data-total-count>
        <span>{totalSessionsLabel}</span>
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
      <div class="layout-toggle" aria-label={t('index.sessionLayout')}>
        <button
          type="button"
          data-layout-btn="timeline"
          aria-pressed={layout === 'timeline'}
          onclick={() => onLayoutChange('timeline')}>{t('index.layoutTimeline')}</button
        >
        <button
          type="button"
          data-layout-btn="projects"
          aria-pressed={layout === 'projects'}
          onclick={() => onLayoutChange('projects')}>{t('index.layoutProjects')}</button
        >
      </div>
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
