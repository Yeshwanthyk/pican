<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getSessionPaletteApi, setSessionPaletteApi } from '../../shared/command-palette-runtime';
  import { icon, X } from '../../shared/icons';
  import { t } from '../../shared/strings';
  import { withBasePath } from '../../shared/base-path';
  import {
    fetchPaletteSessions,
    filterPaletteSessions,
    normalizePaletteSession,
    prioritizePinnedPaletteSessions,
  } from './command-palette';
  import type { PaletteSessionInput } from './command-palette';
  import type { FetchLike } from '../../lib/http';
  import { settle } from './ui-effect';

  interface LoadOptions {
    readonly query: string;
    readonly documentImpl: Document;
    readonly windowImpl: Window;
  }

  interface CommandPaletteProps {
    readonly limit?: number;
    readonly loadSessions?:
      | ((options: LoadOptions) => PromiseLike<ReadonlyArray<PaletteSessionInput>>)
      | null;
    readonly view?: 'home' | 'all' | 'archived';
    readonly onOpen?: (() => void) | null;
    readonly onClose?: (() => void) | null;
    readonly onQueryChange?: ((query: string) => void) | null;
    readonly onNewSession?: (() => void) | null;
    readonly onImportSession?: (() => void) | null;
    readonly clearOnClose?: boolean;
    readonly fetchImpl?: FetchLike | null;
    readonly navigate?: ((url: string) => void) | null;
  }

  let {
    limit = 8,
    loadSessions = null,
    view = 'home',
    onOpen = null,
    onClose = null,
    onQueryChange = null,
    onNewSession = null,
    onImportSession = null,
    clearOnClose = false,
    fetchImpl = null,
    navigate = null,
  }: CommandPaletteProps = $props();

  let overlayEl: HTMLDivElement | null = null;
  let inputEl: HTMLInputElement | null = null;
  let resultButtons: HTMLButtonElement[] = [];
  let open = $state(false);
  let query = $state('');
  let allSessions = $state<ReturnType<typeof normalizePaletteSession>[]>([]);
  let selectedIndex = $state(-1);
  let error = $state('');
  let loadGeneration = 0;

  const effectiveFetch = $derived(fetchImpl || window.fetch.bind(window));
  const visibleSessions = $derived(
    prioritizePinnedPaletteSessions(filterPaletteSessions(allSessions, query)).slice(0, limit),
  );

  function go(url: string) {
    if (!url) return;
    if (navigate) navigate(url);
    else window.location.href = withBasePath(url);
  }

  function close() {
    if (!open) return;
    open = false;
    selectedIndex = -1;
    if (clearOnClose) query = '';
    document.body?.classList.remove('pi-palette-open');
    onClose?.();
  }

  function startNewSession() {
    close();
    if (onNewSession) {
      onNewSession();
      return;
    }
    document.getElementById('new-btn')?.click?.();
    document.getElementById('newSessionBtn')?.click?.();
  }

  async function reloadSessions() {
    const generation = ++loadGeneration;
    error = '';
    const loader =
      loadSessions ||
      (() => fetchPaletteSessions({ fetchImpl: effectiveFetch, query, limit: 50, view }));
    const result = await settle(() =>
      loader({ query, documentImpl: document, windowImpl: window }),
    );
    if (result.ok) {
      if (generation !== loadGeneration) return;
      allSessions = result.value.map(normalizePaletteSession);
      selectedIndex = -1;
    } else {
      if (generation !== loadGeneration) return;
      allSessions = [];
      error = t('palette.failedLoadSessions');
    }
  }

  async function openPalette() {
    if (open) return;
    onOpen?.();
    open = true;
    document.body?.classList.add('pi-palette-open');
    await tick();
    inputEl?.focus();
    await reloadSessions();
  }

  function refresh() {
    return reloadSessions();
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function handleInput() {
    onQueryChange?.(query);
    selectedIndex = -1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => reloadSessions(), 160);
  }

  function selectVisible(index: number) {
    const session = visibleSessions[index];
    if (!session) return;
    close();
    go(session.href);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    const active = document.activeElement;
    const shouldHandle =
      !active ||
      active === inputEl ||
      active === document.body ||
      active === document.documentElement ||
      !overlayEl?.contains(active);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (query) {
        query = '';
        onQueryChange?.(query);
        void reloadSessions();
        return;
      }
      close();
      return;
    }
    if (!shouldHandle) return;
    const last = Math.min(visibleSessions.length, limit) - 1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex =
        selectedIndex < last
          ? selectedIndex + 1
          : selectedIndex === -1 && last >= 0
            ? 0
            : selectedIndex;
      resultButtons[selectedIndex]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedIndex > 0) selectedIndex -= 1;
      else if (selectedIndex === 0) {
        selectedIndex = -1;
        inputEl?.focus();
      } else if (selectedIndex === -1 && last >= 0) selectedIndex = last;
      resultButtons[selectedIndex]?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      const index = selectedIndex >= 0 ? selectedIndex : 0;
      if (visibleSessions[index]) {
        e.preventDefault();
        selectVisible(index);
      }
    }
  }

  onMount(() => {
    const api = { open: openPalette, close, refresh };
    const previousApi = getSessionPaletteApi();
    setSessionPaletteApi(api);
    const previousOpenBridge = window.__piOpenSessionPalette;
    const openBridge = () => api.open();
    // Compatibility shims for existing external/browser entry points. In-app
    // code should import command-palette-runtime helpers instead.
    window.__piSessionPalette = api;
    if (typeof previousOpenBridge !== 'function') window.__piOpenSessionPalette = openBridge;
    const keydown = (event: KeyboardEvent) => handleKeydown(event);
    window.addEventListener('keydown', keydown);
    return () => {
      clearTimeout(searchTimer);
      window.removeEventListener('keydown', keydown);
      if (getSessionPaletteApi() === api) setSessionPaletteApi(previousApi);
      if (window.__piSessionPalette === api) delete window.__piSessionPalette;
      if (window.__piOpenSessionPalette === openBridge) delete window.__piOpenSessionPalette;
      else if (previousOpenBridge && window.__piOpenSessionPalette == null)
        window.__piOpenSessionPalette = previousOpenBridge;
      document.body?.classList.remove('pi-palette-open');
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div
  class="command-palette-overlay"
  id="sessionPalette"
  class:open
  aria-hidden={open ? 'false' : 'true'}
  bind:this={overlayEl}
  role="presentation"
  onclick={(e) => {
    if (e.target === overlayEl) close();
  }}
>
  <div
    class="command-palette"
    role="dialog"
    aria-modal="true"
    aria-label={t('palette.listSessions')}
  >
    <div class="palette-search-wrap">
      <input
        type="text"
        id="session-palette-search"
        placeholder={t('index.searchSessions')}
        autocomplete="off"
        bind:this={inputEl}
        bind:value={query}
        oninput={handleInput}
      />
      <button
        class="palette-search-close"
        type="button"
        data-palette-close
        aria-label={t('palette.closeSearch')}
        onclick={close}>{@html icon(X, { size: 15 })}</button
      >
    </div>
    <div class="palette-results" data-palette-results>
      {#if error}
        <div class="palette-empty">{error}</div>
      {:else if visibleSessions.length === 0}
        <div class="palette-empty plain-state" data-empty="search">
          <div class="plain-state-line">
            {query.trim()
              ? t('palette.noMatches', { query: query.trim() })
              : t('palette.noSessionsFound')}
          </div>
          {#if query.trim()}
            <div class="plain-state-hint">{t('palette.clearSearchHint')}</div>
          {/if}
        </div>
      {:else}
        {#each visibleSessions as session, i (session.id || session.href || i)}
          <button
            type="button"
            class="palette-result"
            class:palette-result--selected={i === selectedIndex}
            bind:this={resultButtons[i]}
            onclick={() => selectVisible(i)}
          >
            <span class="palette-result-title">{session.title}</span>
            <span class="palette-result-meta">{session.meta}</span>
          </button>
        {/each}
      {/if}
    </div>
    <div class="palette-section-title">{t('palette.actions')}</div>
    <button class="palette-action" type="button" data-new-session-btn onclick={startNewSession}
      >{t('palette.newSession')}</button
    >
    <button
      class="palette-action"
      type="button"
      data-schedules-btn
      onclick={() => {
        close();
        go('/schedules');
      }}>{t('schedules.navTitle')}</button
    >
    <button
      class="palette-action muted"
      type="button"
      data-import-session-btn
      disabled={!onImportSession}
      aria-disabled={!onImportSession}
      onclick={() => {
        close();
        onImportSession?.();
      }}>{t('index.importSession')}</button
    >
  </div>
</div>
