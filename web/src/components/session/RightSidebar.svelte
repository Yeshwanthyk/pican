<script lang="ts">
  import { Effect } from 'effect';
  import { onMount } from 'svelte';
  import { runSync } from '../../lib/runtime.js';
  import { icon, CircleHelp, Maximize2, X } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';
  import ArtifactPanel from './ArtifactPanel.svelte';
  import { sessionRuntime } from '../../session/session-runtime.js';
  import { createScratchpadController } from './right-sidebar-scratchpad.js';

  let { scratchpad = '', projectPath = '' }: { scratchpad?: string; projectPath?: string } =
    $props();

  const RIGHT_SIDEBAR_COLLAPSED_KEY = 'pican:v1:right-sidebar-collapsed';
  const RIGHT_SIDEBAR_WIDTH_KEY = 'pican:v1:right-sidebar-width';
  const RIGHT_SIDEBAR_TAB_KEY = 'pican:v1:right-sidebar-tab';
  const MIN_CONTENT_WIDTH = 320;
  const DEFAULT_WIDTH_PX = 320; // double-click reset width
  type SidebarTab = 'scratchpad' | 'artifacts';
  const TAB_PANES: readonly SidebarTab[] = ['scratchpad', 'artifacts'];

  function readStorage(key: string): string | null {
    return runSync(
      Effect.try({
        try: () => globalThis.localStorage?.getItem(key) ?? null,
        catch: () => null,
      }),
    );
  }

  function writeStorage(key: string, value: string): void {
    runSync(
      Effect.try({
        try: () => globalThis.localStorage?.setItem(key, value),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
  }

  function readInitialTab(): SidebarTab {
    const stored = readStorage(RIGHT_SIDEBAR_TAB_KEY);
    if (stored === 'scratchpad' || stored === 'artifacts') return stored;
    return 'scratchpad';
  }

  // The active tab is component-local state bound straight into the markup. The
  // collapse/expand state lives on <body> (it shifts the whole page layout) and
  // callers/tests expect it to react synchronously, so it stays imperative below.
  let activeTab = $state(readInitialTab());

  function activateTab(pane: SidebarTab): void {
    activeTab = pane;
    writeStorage(RIGHT_SIDEBAR_TAB_KEY, pane);
  }

  // Assigned in onMount once the scratchpad controller exists; the visibility
  // helpers below call it when un-collapsing the sidebar.
  let loadScratchpad: () => void = () => undefined;

  function isCollapsed(): boolean {
    return document.body.classList.contains('right-sidebar-collapsed');
  }
  function setCollapsed(collapsed: boolean): void {
    document.body.classList.toggle('right-sidebar-collapsed', collapsed);
    writeStorage(RIGHT_SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }
  function setExpanded(expanded: boolean): void {
    document.body.classList.toggle('right-sidebar-expanded', expanded);
  }
  function toggleSidebar(): void {
    if (isCollapsed()) {
      setCollapsed(false);
      loadScratchpad();
    } else {
      setCollapsed(true);
      setExpanded(false);
    }
  }
  function openSidebar(): void {
    if (isCollapsed()) {
      setCollapsed(false);
      loadScratchpad();
    }
  }
  function collapseSidebar(): void {
    setExpanded(false);
    setCollapsed(true);
  }
  function toggleExpanded(): void {
    if (document.body.classList.contains('right-sidebar-expanded')) {
      setExpanded(false);
    } else {
      if (isCollapsed()) setCollapsed(false);
      setExpanded(true);
      loadScratchpad();
    }
  }

  onMount(() => {
    const documentImpl = document;
    const windowImpl = window;
    const sidebar = documentImpl.getElementById('right-sidebar');
    const resizer = documentImpl.getElementById('right-sidebar-resizer');
    const textarea = documentImpl.querySelector<HTMLTextAreaElement>('#scratchpad-textarea');
    const statusEl = documentImpl.getElementById('scratchpad-status');
    const toggleBtn = documentImpl.getElementById('toggle-right-sidebar-btn');
    const backdrop = documentImpl.getElementById('right-sidebar-backdrop');
    const cleanups: Array<() => void> = [];

    // The toggle button lives in <SessionHeader>; the backdrop is a
    // non-interactive overlay — both are wired by id to avoid an a11y lint on a
    // click handler attached to a static element.
    if (toggleBtn) {
      toggleBtn.addEventListener('click', toggleSidebar);
      cleanups.push(() => toggleBtn.removeEventListener('click', toggleSidebar));
    }
    if (backdrop) {
      backdrop.addEventListener('click', collapseSidebar);
      cleanups.push(() => backdrop.removeEventListener('click', collapseSidebar));
    }

    sessionRuntime.rightSidebar = {
      toggle: toggleSidebar,
      open: openSidebar,
      collapse: collapseSidebar,
      activateTab,
    };

    if (!sidebar) {
      return () => {
        for (const fn of cleanups) fn();
        sessionRuntime.rightSidebar = null;
      };
    }

    // ── Scratchpad load/save ─────────────────────────────────────────────────
    const scratchpadController = createScratchpadController({
      projectPath,
      textarea,
      statusEl,
      fetchImpl: fetch,
    });
    loadScratchpad = () => void scratchpadController.load();
    if (textarea) cleanups.push(scratchpadController.bind());

    function getRightSidebarBounds(): { minWidth: number; maxWidth: number } {
      const rootStyles = windowImpl.getComputedStyle(documentImpl.documentElement);
      const minWidth = parseFloat(rootStyles.getPropertyValue('--right-sidebar-min-width')) || 240;
      const maxWidth = parseFloat(rootStyles.getPropertyValue('--right-sidebar-max-width')) || 640;
      const viewportMaxWidth = windowImpl.innerWidth - MIN_CONTENT_WIDTH;
      return { minWidth, maxWidth: Math.max(minWidth, Math.min(maxWidth, viewportMaxWidth)) };
    }
    function clampWidth(width: number): number {
      const { minWidth, maxWidth } = getRightSidebarBounds();
      return Math.max(minWidth, Math.min(maxWidth, width));
    }
    function applyWidth(width: number): void {
      const clamped = Math.round(clampWidth(width));
      documentImpl.documentElement.style.setProperty('--right-sidebar-width', `${clamped}px`);
    }
    function loadWidth(): number | null {
      const raw = readStorage(RIGHT_SIDEBAR_WIDTH_KEY);
      if (raw === null) return null;
      const width = Number(raw);
      return Number.isFinite(width) ? width : null;
    }
    function saveWidth(width: number): void {
      writeStorage(RIGHT_SIDEBAR_WIDTH_KEY, String(Math.round(clampWidth(width))));
    }

    // ── Resize (drag left edge) ──────────────────────────────────────────────
    if (resizer) {
      const savedWidth0 = loadWidth();
      if (savedWidth0 !== null) applyWidth(savedWidth0);

      let cleanupDrag: ((pointerId: number) => void) | null = null;

      const stopDrag = (pointerId: number): void => {
        if (cleanupDrag) {
          cleanupDrag(pointerId);
          cleanupDrag = null;
        }
      };

      const onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = sidebar.getBoundingClientRect().width;
        documentImpl.body.classList.add('right-sidebar-resizing');
        resizer.setPointerCapture?.(e.pointerId);

        const onPointerMove = (ev: PointerEvent): void => {
          applyWidth(startWidth + (startX - ev.clientX));
        };
        const onPointerUp = (ev: PointerEvent): void => stopDrag(ev.pointerId);
        const onPointerCancel = (ev: PointerEvent): void => stopDrag(ev.pointerId);

        cleanupDrag = (ptrId: number): void => {
          documentImpl.body.classList.remove('right-sidebar-resizing');
          resizer.releasePointerCapture?.(ptrId);
          windowImpl.removeEventListener('pointermove', onPointerMove);
          windowImpl.removeEventListener('pointerup', onPointerUp);
          windowImpl.removeEventListener('pointercancel', onPointerCancel);
          saveWidth(sidebar.getBoundingClientRect().width);
        };

        windowImpl.addEventListener('pointermove', onPointerMove);
        windowImpl.addEventListener('pointerup', onPointerUp);
        windowImpl.addEventListener('pointercancel', onPointerCancel);
      };
      resizer.addEventListener('pointerdown', onPointerDown);
      cleanups.push(() => resizer.removeEventListener('pointerdown', onPointerDown));

      const onDblClick = (): void => {
        applyWidth(DEFAULT_WIDTH_PX);
        saveWidth(DEFAULT_WIDTH_PX);
      };
      resizer.addEventListener('dblclick', onDblClick);
      cleanups.push(() => resizer.removeEventListener('dblclick', onDblClick));

      const onWindowResize = (): void => {
        applyWidth(sidebar.getBoundingClientRect().width);
      };
      windowImpl.addEventListener('resize', onWindowResize);
      cleanups.push(() => windowImpl.removeEventListener('resize', onWindowResize));
    }

    // Bootstrap path: scratchpad arrives in the prop and is server-rendered into
    // the textarea, so adopt it as the baseline. SPA-nav path: the prop is empty
    // (loadSessionPageState skips the scratchpad fetch to keep it off the
    // critical path), so fetch it here instead.
    const savedWidth = loadWidth();
    if (savedWidth !== null) applyWidth(savedWidth);
    if (textarea && !textarea.value && projectPath) {
      void scratchpadController.load();
    } else {
      scratchpadController.adoptCurrentValue();
    }

    // ── Artifacts help (?) modal ─────────────────────────────────────────────
    // Shown only on the Artifacts tab via CSS; toggled by the help button.
    const helpBtn = documentImpl.getElementById('artifact-help-btn');
    const helpModal = documentImpl.getElementById('artifact-help-modal');
    if (helpBtn && helpModal) {
      const hideHelp = (): void => {
        helpModal.hidden = true;
      };
      const onHelpBtn = (): void => {
        helpModal.hidden = false;
      };
      const onHelpModal = (e: MouseEvent): void => {
        if (e.target instanceof Element && e.target.closest('[data-action="close-artifact-help"]'))
          hideHelp();
      };
      const onHelpKeydown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' && !helpModal.hidden) hideHelp();
      };
      helpBtn.addEventListener('click', onHelpBtn);
      helpModal.addEventListener('click', onHelpModal);
      windowImpl.addEventListener('keydown', onHelpKeydown);
      cleanups.push(() => {
        helpBtn.removeEventListener('click', onHelpBtn);
        helpModal.removeEventListener('click', onHelpModal);
        windowImpl.removeEventListener('keydown', onHelpKeydown);
      });
    }

    return () => {
      for (const fn of cleanups) fn();
      sessionRuntime.rightSidebar = null;
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div
  id="right-sidebar-resizer"
  class="right-sidebar-resizer"
  role="separator"
  aria-orientation="vertical"
  aria-label={t('sidebar.resizeScratchpad')}
></div>
<aside id="right-sidebar" class="right-sidebar" data-active-tab={activeTab}>
  <div class="right-sidebar-header">
    <div class="right-sidebar-tabs" role="tablist">
      <button
        type="button"
        id="right-tab-scratchpad"
        class="right-sidebar-tab"
        class:active={activeTab === 'scratchpad'}
        role="tab"
        data-pane="scratchpad"
        aria-selected={activeTab === 'scratchpad'}
        onclick={() => activateTab('scratchpad')}>{t('sidebar.scratchpad')}</button
      >
      <button
        type="button"
        id="right-tab-artifacts"
        class="right-sidebar-tab"
        class:active={activeTab === 'artifacts'}
        role="tab"
        data-pane="artifacts"
        aria-selected={activeTab === 'artifacts'}
        onclick={() => activateTab('artifacts')}
        >{t('sidebar.artifacts')}<span
          id="artifact-tab-count"
          class="right-sidebar-tab-count"
          hidden>0</span
        ></button
      >
    </div>
    <div class="right-sidebar-actions">
      <button
        id="expand-right-sidebar"
        class="right-sidebar-btn"
        title={t('sidebar.expandPanel')}
        onclick={toggleExpanded}>{@html icon(Maximize2, { size: 14 })}</button
      >
      <button
        id="close-right-sidebar"
        class="right-sidebar-btn"
        title={`${t('sidebar.hidePanel')} (⌘⇧N)`}
        onclick={collapseSidebar}>{@html icon(X, { size: 15 })}</button
      >
    </div>
  </div>
  <div class="right-sidebar-content">
    <div
      id="right-pane-scratchpad"
      class="right-sidebar-pane"
      class:active={activeTab === 'scratchpad'}
      role="tabpanel"
      aria-labelledby="right-tab-scratchpad"
      hidden={activeTab !== 'scratchpad'}
    >
      <textarea
        id="scratchpad-textarea"
        class="scratchpad-textarea"
        placeholder={t('sidebar.scratchpadPlaceholder')}>{scratchpad}</textarea
      >
    </div>
    <div
      id="right-pane-artifacts"
      class="right-sidebar-pane"
      class:active={activeTab === 'artifacts'}
      role="tabpanel"
      aria-labelledby="right-tab-artifacts"
      hidden={activeTab !== 'artifacts'}
    >
      <button
        id="artifact-help-btn"
        class="right-sidebar-btn artifact-help-btn"
        title={t('sidebar.howArtifactsWork')}
        aria-label={t('sidebar.howArtifactsWork')}>{@html icon(CircleHelp, { size: 15 })}</button
      >
      <ArtifactPanel />
    </div>
  </div>
  <div class="right-sidebar-footer">
    <span id="scratchpad-status" class="scratchpad-status">{t('common.saved')}</span>
  </div>
</aside>
<div id="right-sidebar-backdrop" class="right-sidebar-backdrop"></div>
<div id="artifact-help-modal" class="artifact-help-modal" hidden>
  <div class="artifact-help-backdrop" data-action="close-artifact-help"></div>
  <div
    class="artifact-help-card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="artifact-help-title"
  >
    <div class="artifact-help-header">
      <h3 id="artifact-help-title">{t('sidebar.howArtifactsWork')}</h3>
      <button
        class="artifact-help-close"
        data-action="close-artifact-help"
        aria-label={t('common.close')}>{@html icon(X, { size: 16 })}</button
      >
    </div>
    <div class="artifact-help-body">
      <p>{@html t('artifactHelp.intro')}</p>
      <p>{@html t('artifactHelp.viewing')}</p>
      <p>{@html t('artifactHelp.upToDate')}</p>
      <p class="artifact-help-note">{t('artifactHelp.note')}</p>
    </div>
  </div>
</div>
