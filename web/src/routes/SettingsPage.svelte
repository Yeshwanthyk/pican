<script lang="ts">
  import { onMount } from 'svelte';
  import AppearanceSettings from '../components/settings/AppearanceSettings.svelte';
  import ArtifactSettings from '../components/settings/ArtifactSettings.svelte';
  import MachinesSettings from '../components/settings/MachinesSettings.svelte';
  import NotificationSettings from '../components/settings/NotificationSettings.svelte';
  import SessionDisplayDefaultsSettings from '../components/settings/SessionDisplayDefaultsSettings.svelte';
  import SessionsListSettings from '../components/settings/SessionsListSettings.svelte';
  import SessionTitleSettings from '../components/settings/SessionTitleSettings.svelte';
  import { icon, ArrowLeft, ChevronRight } from '../shared/icons';
  import { t } from '../shared/strings';
  import { navigate } from '../shared/navigation';
  import { loadSettings, persistSetting } from '../settings/settings-support';
  import type { Settings } from '../settings/settings-support';
  import { recoverSync, settle } from '../components/shared/ui-effect';
  import { stripBasePath, withBasePath } from '../shared/base-path';

  let settings = $state<Settings>({});
  let savedVisible = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

  const sections = [
    { id: 'appearance', labelKey: 'settings.appearance' },
    { id: 'sessionsList', labelKey: 'settings.sessionsList' },
    { id: 'sessionTitles', labelKey: 'settings.sessionTitles' },
    { id: 'sessionDisplay', labelKey: 'settings.sessionDisplay' },
    { id: 'artifacts', labelKey: 'settings.artifacts' },
    { id: 'notifications', labelKey: 'settings.notifications' },
    { id: 'machines', labelKey: 'settings.machines' },
  ];
  const sectionIds = new Set(sections.map((s) => s.id));

  let activeSection = $state('appearance');
  let isMobile = $state(false);
  let mobileShowingPane = $state(false);
  let cameFromApp = $state(false);

  const activeLabel = $derived(
    t(sections.find((s) => s.id === activeSection)?.labelKey || 'settings.title'),
  );

  function sectionFromUrl(win: Window): string | null {
    return recoverSync(() => {
      const id = new URLSearchParams(win.location.search).get('section');
      return id && sectionIds.has(id) ? id : null;
    }, null);
  }

  function syncSectionUrl(win: Window, id: string) {
    recoverSync(() => {
      win.history.replaceState(win.history.state, '', `${win.location.pathname}?section=${id}`);
    }, undefined);
  }

  function selectSection(id: string) {
    activeSection = id;
    if (isMobile) mobileShowingPane = true;
    syncSectionUrl(window, id);
  }

  function backToList() {
    mobileShowingPane = false;
  }

  function onHomeBack(e: MouseEvent) {
    if (e.defaultPrevented) return;
    if (typeof e.button === 'number' && e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (cameFromApp && window.history && window.history.length > 1) {
      window.history.back();
    } else {
      navigate('/');
    }
  }

  function flashSaved() {
    savedVisible = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedVisible = false;
    }, 1200);
  }

  function saveSetting(key: string, value: string) {
    settings = { ...settings, [key]: value };
    persistSetting(key, value, { storage: localStorage });
    flashSaved();
  }

  onMount(() => {
    const previousTitle = document.title;
    document.title = `${t('settings.title')} — ${t('common.productName')}`;

    cameFromApp = recoverSync(() => {
      const ref = document.referrer;
      return (
        !!ref &&
        new URL(ref).origin === window.location.origin &&
        stripBasePath(new URL(ref).pathname) !== '/settings'
      );
    }, false);

    const mq = window.matchMedia?.('(max-width: 760px)');
    const updateMobile = () => {
      isMobile = !!mq?.matches;
      if (!isMobile) mobileShowingPane = false;
    };
    updateMobile();
    mq?.addEventListener('change', updateMobile);

    const initialSection = sectionFromUrl(window);
    if (initialSection) {
      activeSection = initialSection;
      if (isMobile) mobileShowingPane = true;
    }

    void settle(() => loadSettings({ windowImpl: window })).then((result) => {
      if (result.ok) settings = result.value;
    });
    return () => {
      document.title = previousTitle;
      clearTimeout(savedTimer);
      mq?.removeEventListener('change', updateMobile);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG from icons.js -->

<div class="session-header-bar">
  <div class="session-header-left">
    {#if isMobile && mobileShowingPane}
      <button type="button" class="session-header-back" onclick={backToList}>
        <span aria-hidden="true">{@html icon(ArrowLeft, { size: 14 })}</span>
        {t('settings.title')}
      </button>
    {:else}
      <a class="session-header-back" href={withBasePath('/')} onclick={onHomeBack}>
        <span aria-hidden="true">{@html icon(ArrowLeft, { size: 14 })}</span>
        {cameFromApp ? t('common.back') : t('session.back')}
      </a>
    {/if}
  </div>
  <span class="session-header-title">
    {isMobile && mobileShowingPane ? activeLabel : t('settings.title')}
  </span>
  <div class="session-header-right"></div>
</div>

<div
  class="settings-page"
  class:settings-page-mobile-list={isMobile && !mobileShowingPane}
  class:settings-page-mobile-pane={isMobile && mobileShowingPane}
>
  <nav class="settings-sidebar" aria-label={t('settings.title')}>
    {#each sections as section (section.id)}
      <button
        type="button"
        class="settings-sidebar-item"
        class:active={activeSection === section.id}
        data-settings-nav={section.id}
        aria-current={activeSection === section.id ? 'page' : undefined}
        onclick={() => selectSection(section.id)}
      >
        <span>{t(section.labelKey)}</span>
        <span class="settings-sidebar-chev" aria-hidden="true"
          >{@html icon(ChevronRight, { size: 14 })}</span
        >
      </button>
    {/each}
  </nav>

  <div class="settings-pane">
    {#if activeSection === 'appearance'}
      <AppearanceSettings {settings} onSave={saveSetting} onSaved={flashSaved} />
    {:else if activeSection === 'sessionsList'}
      <SessionsListSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'sessionTitles'}
      <SessionTitleSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'sessionDisplay'}
      <SessionDisplayDefaultsSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'artifacts'}
      <ArtifactSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'notifications'}
      <NotificationSettings {settings} onSave={saveSetting} />
    {:else if activeSection === 'machines'}
      <MachinesSettings />
    {/if}
  </div>

  <div class="settings-saved-hint" class:visible={savedVisible} data-settings-saved>
    {t('common.saved')}
  </div>
</div>
