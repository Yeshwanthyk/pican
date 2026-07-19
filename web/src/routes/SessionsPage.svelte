<script lang="ts">
  import { onMount, tick } from 'svelte';
  import CommandPalette from '../components/shared/CommandPalette.svelte';
  import HomeMenu from '../components/index/HomeMenu.svelte';
  import IndexHeader from '../components/index/IndexHeader.svelte';
  import HomeRail from '../components/index/HomeRail.svelte';
  import NewSessionModal from '../components/index/NewSessionModal.svelte';
  import ProjectsModal from '../components/index/ProjectsModal.svelte';
  import SessionsList from '../components/index/SessionsList.svelte';
  import { createStatusEvents } from '../shared/status-events.js';
  import { openSessionPalette, refreshSessionPalette } from '../shared/command-palette-runtime.js';
  import { setupKeyboardNav } from '../shared/keyboard-nav.js';
  import { toggleTheme, syncThemeIcons } from '../shared/theme.js';
  import {
    configureSettingsSync,
    hydrateSettings,
    writeSetting,
  } from '../shared/settings-store.js';
  import { navigate } from '../shared/navigation.js';
  import { t } from '../shared/strings.js';
  import { describeError } from '../lib/errors';
  import type { Project, Schedule } from '../lib/schema';
  import { sendChat } from '../session/chat/chat-api.js';
  import { defaultFetchSchedules } from '../index/schedules.js';
  import { showToast } from '../shared/toast.js';
  import { ignoreFailure, recoverSync, settle } from '../components/shared/ui-effect';
  import { SvelteSet, SvelteMap } from 'svelte/reactivity';
  import {
    defaultCreateSession,
    defaultFetchProjects,
    defaultFetchRecent,
    defaultFetchSessions,
    defaultUpdateProject,
    layoutStorageKey,
    normalizeRecentLocations,
    normalizeSession,
    shouldRefetchOnReload,
    type NormalizedSession,
    type RunningStatus,
  } from '../index/sessions.js';
  import {
    defaultFetchPeers,
    defaultFetchPeerSessions,
    normalizePeerHost,
    type NormalizedPeerHost,
  } from '../index/peers.js';

  const PAGE_SIZE = 100;
  type Layout = 'timeline' | 'projects';

  let sessions = $state<NormalizedSession[]>([]);
  let total = $state(0);
  let loadingMore = $state(false);
  let loading = $state(true);
  let layoutReady = $state(false);
  let layout = $state<Layout>('timeline');
  const runningSessionIds = new SvelteSet<string>();
  const runningStatuses = new SvelteMap<string, RunningStatus>();
  let newSessionOpen = $state(false);
  let newSessionPath = $state('');
  let newSessionDropdownOpen = $state(false);
  let newSessionRuntime = $state('pi');
  let recentLocations = $state<string[]>([]);
  let creating = $state(false);
  let newSessionError = $state('');
  let menuOpen = $state(false);
  let projectsOpen = $state(false);
  let projects = $state<Project[]>([]);
  let projectsFilterEnabled = $state(false);
  let projectsBusy = $state(false);
  let projectsError = $state('');
  let refreshInflight = false;
  let peersConfigured = false;
  let peerHosts = $state<NormalizedPeerHost[]>([]);
  let peersRefreshInflight = false;
  let schedules = $state<Schedule[]>([]);

  const defaultProject = $derived(recentLocations[0] || t('index.defaultProject'));

  const totalSessionsLabel = $derived(
    total === 1 ? t('index.sessionCountOne') : t('index.sessionsCount', { count: total }),
  );
  const hasMore = $derived(sessions.length < total);
  const waitingSessions = $derived(sessions.filter((session) => session.waitingQuestion));
  const waitingIds = $derived(new Set(waitingSessions.map((session) => session.id)));
  const waitingCount = $derived(waitingSessions.length);
  const runningCount = $derived(
    [...runningSessionIds].filter((sessionId) => !waitingIds.has(sessionId)).length,
  );

  function normalizeRunningStatus(value: unknown): RunningStatus | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const status = value as Partial<Record<keyof RunningStatus, unknown>>;
    return {
      modelName: typeof status.modelName === 'string' ? status.modelName : undefined,
      model: typeof status.model === 'string' ? status.model : undefined,
      modelProvider: typeof status.modelProvider === 'string' ? status.modelProvider : undefined,
    };
  }

  function setRunningSessions(snapshot: {
    readonly ids: ReadonlyArray<string>;
    readonly statuses: Readonly<Record<string, unknown>>;
  }): void {
    runningSessionIds.clear();
    for (const id of snapshot.ids) runningSessionIds.add(id);
    runningStatuses.clear();
    for (const [key, value] of Object.entries(snapshot.statuses)) {
      const status = normalizeRunningStatus(value);
      if (status) runningStatuses.set(key, status);
    }
  }

  function setSessionRunning(id: string, running: boolean, status: RunningStatus = {}): void {
    if (running) {
      runningSessionIds.add(id);
      runningStatuses.set(id, status);
    } else {
      runningSessionIds.delete(id);
      runningStatuses.delete(id);
    }
  }

  async function refreshSessions({ preserveWindow = false } = {}) {
    if (refreshInflight || newSessionOpen) return;
    refreshInflight = true;
    const limit = preserveWindow ? Math.max(PAGE_SIZE, sessions.length) : PAGE_SIZE;
    const result = await settle(() => defaultFetchSessions({ limit }));
    if (result.ok) {
      sessions = (result.value.sessions || []).map(normalizeSession);
      total = result.value.total ?? sessions.length;
      await tick();
      refreshSessionPalette();
    }
    // Keep the existing list if a soft refresh fails.
    refreshInflight = false;
    loading = false;
    layoutReady = true;
  }

  async function loadMore() {
    if (loadingMore || refreshInflight) return;
    loadingMore = true;
    const result = await settle(() =>
      defaultFetchSessions({ limit: PAGE_SIZE, offset: sessions.length }),
    );
    if (result.ok) {
      const more = (result.value.sessions || []).map(normalizeSession);
      const seen = new Set(sessions.map((session) => session.id));
      sessions = [...sessions, ...more.filter((session) => !seen.has(session.id))];
      total = result.value.total ?? total;
    }
    // Leave the loaded list untouched if a page fails to load.
    loadingMore = false;
  }

  const RELOAD_DEBOUNCE_MS = 500;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleReload(): void {
    if (reloadTimer) clearTimeout(reloadTimer);
    if (newSessionOpen) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      refreshSessions({ preserveWindow: true });
      refreshPeerHosts();
    }, RELOAD_DEBOUNCE_MS);
  }

  // Damps the reload storm: a global "reload:<id>" broadcast fires on every
  // append to any streaming session, indefinitely. A brand-new (unknown) id
  // still refreshes right away so it appears promptly; a known id only
  // refreshes at most once per KNOWN_ID_REFRESH_THROTTLE_MS, since all a
  // known session's reload updates activity/waiting summaries at a bounded rate.
  const KNOWN_ID_REFRESH_THROTTLE_MS = 5000;
  let lastKnownIdRefreshAt = 0;
  function handleReload({ id }: { readonly id: string }): void {
    const now = Date.now();
    const knownIds = new Set(sessions.map((session) => session.id));
    if (
      !shouldRefetchOnReload({
        id,
        knownIds,
        lastRefreshAt: lastKnownIdRefreshAt,
        now,
        throttleMs: KNOWN_ID_REFRESH_THROTTLE_MS,
      })
    ) {
      return;
    }
    lastKnownIdRefreshAt = now;
    scheduleReload();
  }

  // Peers (multi-machine "Machines" section): zero overhead for single-machine
  // users — /api/peers/sessions is only ever fetched once at least one peer is
  // registered, and initPeers() runs that check exactly once per page load.
  async function refreshPeerHosts() {
    if (!peersConfigured || peersRefreshInflight) return;
    peersRefreshInflight = true;
    const result = await settle(defaultFetchPeerSessions);
    if (result.ok) {
      peerHosts = (result.value.hosts || []).map(normalizePeerHost);
    }
    // Keep last-known state if a poll fails.
    peersRefreshInflight = false;
  }

  async function initPeers() {
    const result = await settle(defaultFetchPeers);
    peersConfigured = result.ok && (result.value.peers || []).length > 0;
    if (peersConfigured) await refreshPeerHosts();
  }

  async function refreshSchedules() {
    const result = await settle(defaultFetchSchedules);
    if (result.ok) schedules = [...result.value.schedules];
  }

  async function answerWaitingQuestion(
    session: NormalizedSession,
    answer: string,
  ): Promise<boolean> {
    const question = session.waitingQuestion;
    const body = new FormData();
    body.set('message', `"${question}" = "${answer}"`);
    const result = await settle(() => sendChat(session.id, body));
    if (!result.ok || !result.value.ok) {
      showToast(t('index.answerFailed'));
      return false;
    }
    session.waitingQuestion = '';
    session.waitingOptions = [];
    return true;
  }

  function setLayout(nextLayout: string): void {
    layout = nextLayout === 'projects' ? 'projects' : 'timeline';
    writeSetting(layoutStorageKey, layout, { storage: localStorage });
  }

  async function openNewSessionModal() {
    closeMenu();
    projectsOpen = false;
    newSessionOpen = true;
    newSessionPath = '';
    newSessionDropdownOpen = false;
    newSessionRuntime = 'pi';
    newSessionError = '';
    document.body?.classList.add('modal-sheet-open');
    const result = await settle(defaultFetchRecent);
    recentLocations = result.ok ? normalizeRecentLocations(result.value).slice(0, 10) : [];
    await tick();
    document.getElementById('sessionPath')?.focus();
  }

  function closeNewSessionModal() {
    newSessionOpen = false;
    newSessionDropdownOpen = false;
    document.body?.classList.remove('modal-sheet-open');
  }

  async function createSession() {
    const path = newSessionPath.trim();
    if (!path) {
      newSessionError = t('index.enterPath');
      return;
    }
    creating = true;
    newSessionError = '';
    const result = await settle(() => defaultCreateSession(path, newSessionRuntime));
    if (result.ok) {
      if (result.value.ok && result.value.id) {
        creating = false;
        navigate('/session?id=' + encodeURIComponent(result.value.id));
        return;
      }
      newSessionError = t('index.failedCreateSession');
    } else {
      newSessionError = describeError(result.error.cause) || t('index.networkError');
    }
    creating = false;
  }

  function closeMenu() {
    menuOpen = false;
  }
  function toggleMenu() {
    menuOpen = !menuOpen;
  }

  async function refreshProjectsList() {
    projectsError = '';
    projectsBusy = true;
    const result = await settle(defaultFetchProjects);
    if (result.ok) {
      projects = Array.isArray(result.value.projects) ? result.value.projects : [];
      projectsFilterEnabled = !!result.value.filterEnabled;
    } else {
      projectsError = describeError(result.error.cause) || t('index.failedLoadProjects');
    }
    projectsBusy = false;
  }

  async function openProjectsModal() {
    closeMenu();
    newSessionOpen = false;
    projectsOpen = true;
    document.body?.classList.add('modal-sheet-open');
    await refreshProjectsList();
  }

  function closeProjectsModal() {
    projectsOpen = false;
    document.body?.classList.remove('modal-sheet-open');
  }

  async function updateProject(path: string, action: string): Promise<void> {
    projectsBusy = true;
    projectsError = '';
    const result = await settle(() => defaultUpdateProject(path, action));
    if (result.ok) {
      await refreshSessions();
      await refreshProjectsList();
    } else {
      projectsError = describeError(result.error.cause) || t('index.failedUpdateProject');
    }
    projectsBusy = false;
  }

  function openPalette() {
    openSessionPalette();
  }

  onMount(() => {
    const previousTitle = document.title;
    document.title = t('common.productName');
    configureSettingsSync({ fetchImpl: window.fetch.bind(window) });
    setupKeyboardNav({ windowImpl: window, documentImpl: document });

    layout = recoverSync(
      () => (localStorage.getItem(layoutStorageKey) === 'projects' ? 'projects' : 'timeline'),
      'timeline' as Layout,
    );
    ignoreFailure(async () => {
      const settings = await hydrateSettings({ storage: localStorage });
      if (!settings) return;
      const serverLayout = settings[layoutStorageKey] === 'projects' ? 'projects' : 'timeline';
      if (serverLayout !== layout) setLayout(serverLayout);
    });

    const statusEvents = createStatusEvents({
      onSnapshot: (snapshot) => setRunningSessions(snapshot),
      onDelta: (status) =>
        setSessionRunning(status.id, status.running, {
          model: status.model,
          modelName: status.modelName,
          modelProvider: status.modelProvider,
        }),
      onMessage: (message) => {
        if (message === 'new-session') refreshSessions({ preserveWindow: true });
      },
      onReload: handleReload,
      // Catch up on reconnect (network blip, or tab resumed via pageshow):
      // without this the list stays stale until an unrelated broadcast
      // happens to arrive.
      onReconnect: () => refreshSessions({ preserveWindow: true }),
    });
    recoverSync(() => {
      statusEvents.connect();
      return true;
    }, false);

    const keydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        e.stopPropagation();
        toggleTheme(
          {
            localStorage: window.localStorage,
            getComputedStyle: () => window.getComputedStyle(document.documentElement),
          },
          document,
        );
        syncThemeIcons(document);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.key === 'Escape') {
        if (menuOpen) closeMenu();
        else if (projectsOpen) closeProjectsModal();
        else if (newSessionOpen) {
          // Two-step: first Escape dismisses the directory/project dropdown,
          // second Escape (dropdown already closed) closes the modal.
          if (newSessionDropdownOpen) newSessionDropdownOpen = false;
          else closeNewSessionModal();
        }
      }
    };
    window.addEventListener('keydown', keydown, { capture: true });
    const click = () => closeMenu();
    window.addEventListener('click', click);

    refreshSessions();
    ignoreFailure(async () => {
      const recent = await defaultFetchRecent();
      recentLocations = normalizeRecentLocations(recent).slice(0, 10);
    });
    initPeers();
    refreshSchedules();

    return () => {
      document.title = previousTitle;
      document.body?.classList.remove('modal-sheet-open');
      window.removeEventListener('keydown', keydown, { capture: true });
      window.removeEventListener('click', click);
      statusEvents.cleanup?.();
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  });
</script>

<IndexHeader
  {layout}
  {totalSessionsLabel}
  {runningCount}
  {waitingCount}
  {menuOpen}
  onSearch={openPalette}
  onNewSession={openNewSessionModal}
  onToggleMenu={toggleMenu}
  onLayoutChange={setLayout}
  onSchedules={() => navigate('/schedules')}
/>

<HomeMenu
  open={menuOpen}
  {layout}
  onClose={closeMenu}
  onNewSession={openNewSessionModal}
  onManageProjects={openProjectsModal}
  onLayoutChange={setLayout}
  onSchedules={() => navigate('/schedules')}
/>

<CommandPalette onNewSession={openNewSessionModal} navigate={(url: string) => navigate(url)} />

<main class="home-layout">
  <SessionsList
    {sessions}
    {layout}
    {runningSessionIds}
    {runningStatuses}
    {loading}
    {layoutReady}
    {hasMore}
    {loadingMore}
    onLoadMore={loadMore}
    {defaultProject}
  />
  <HomeRail
    {waitingSessions}
    {schedules}
    {peerHosts}
    onAnswer={answerWaitingQuestion}
    onSchedules={() => navigate('/schedules')}
  />
</main>

<nav class="mobile-thumb-bar" aria-label={t('index.mobileActions')}>
  <button type="button" class="mobile-thumb-search" onclick={openPalette}
    ><span>{t('index.searchSessions')}</span><kbd>⌘K</kbd></button
  >
  <button
    type="button"
    class="mobile-thumb-new"
    data-new-session-btn
    aria-label={t('index.startNewSession')}
    onclick={openNewSessionModal}>+</button
  >
  <button
    type="button"
    class="mobile-thumb-menu"
    id="web-menu-btn-mobile"
    aria-label={t('index.openMenu')}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    aria-controls="web-menu"
    onclick={(event) => {
      event.stopPropagation();
      toggleMenu();
    }}>⋯</button
  >
</nav>

<NewSessionModal
  open={newSessionOpen}
  recent={recentLocations}
  bind:path={newSessionPath}
  bind:dropdownOpen={newSessionDropdownOpen}
  bind:runtime={newSessionRuntime}
  {creating}
  error={newSessionError}
  onClose={closeNewSessionModal}
  onCreate={createSession}
/>

<ProjectsModal
  open={projectsOpen}
  {projects}
  filterEnabled={projectsFilterEnabled}
  error={projectsError}
  busy={projectsBusy}
  onClose={closeProjectsModal}
  onToggleProject={(path, enabled) => updateProject(path, enabled ? 'enable' : 'disable')}
  onToggleAll={(enabled) => updateProject('', enabled ? 'enable-all' : 'disable-all')}
  onToggleFilter={(enabled) => updateProject('', enabled ? 'enable-filter' : 'disable-filter')}
  onRegister={(path) => updateProject(path, 'register')}
  onRemove={(path) => updateProject(path, 'remove')}
/>
