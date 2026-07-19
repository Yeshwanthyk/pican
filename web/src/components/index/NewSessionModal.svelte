<script lang="ts">
  import { icon, ArrowLeft } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';
  import {
    defaultBrowsePath,
    filterProjectsByQuery,
    isPathLikeQuery,
    moveHighlight,
    projectsToEntries,
    withParentEntry,
  } from '../../index/dir-browse.js';
  import {
    defaultFetchProjects,
    defaultFetchRuntimes,
    normalizeRuntimesResponse,
    type NormalizedRuntime,
  } from '../../index/sessions.js';
  import type { DirEntry, Project, RuntimesResponse } from '../../lib/schema';
  import { ignoreFailure, settle } from '../shared/ui-effect';

  interface Props {
    open?: boolean;
    recent?: ReadonlyArray<string>;
    path?: string;
    creating?: boolean;
    error?: string;
    dropdownOpen?: boolean;
    runtime?: string;
    fetchRuntimes?: () => Promise<RuntimesResponse>;
    onClose?: () => void;
    onCreate?: () => void | Promise<void>;
  }

  let {
    open = false,
    recent = [],
    path = $bindable(''),
    creating = false,
    error = '',
    dropdownOpen = $bindable(false),
    runtime = $bindable('pi'),
    fetchRuntimes = defaultFetchRuntimes,
    onClose = () => {},
    onCreate = () => {},
  }: Props = $props();

  let inputEl = $state<HTMLInputElement>();
  let projects = $state<Project[]>([]);
  let projectsLoaded = false;
  let browsedEntries = $state<DirEntry[]>([]);
  let parentPath = $state('');
  let pathExists = $state(true);
  let highlightIndex = $state(-1);
  let browseGeneration = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimes = $state<ReadonlyArray<NormalizedRuntime>>([]);
  let runtimeGeneration = 0;

  const pathLike = $derived(isPathLikeQuery(path));
  const visibleEntries = $derived(
    pathLike
      ? withParentEntry(browsedEntries, parentPath)
      : projectsToEntries(filterProjectsByQuery(projects, path)),
  );
  const showCreateHint = $derived(
    pathLike && path.trim() !== '' && !pathExists && browsedEntries.length === 0,
  );

  async function loadProjectsOnce() {
    if (projectsLoaded) return;
    projectsLoaded = true;
    const result = await settle(defaultFetchProjects);
    projects = result.ok && Array.isArray(result.value.projects) ? result.value.projects : [];
  }

  $effect(() => {
    if (open) loadProjectsOnce();
  });

  async function loadRuntimes(generation: number): Promise<void> {
    const result = await settle(fetchRuntimes);
    if (generation !== runtimeGeneration) return;
    const normalized = normalizeRuntimesResponse(result.ok ? result.value : undefined);
    runtimes = normalized.runtimes;
    runtime = normalized.selectedRuntime;
  }

  $effect(() => {
    if (!open) {
      runtimeGeneration += 1;
      return;
    }
    const generation = ++runtimeGeneration;
    runtimes = [];
    runtime = '';
    ignoreFailure(() => loadRuntimes(generation));
    return () => {
      runtimeGeneration += 1;
    };
  });

  function closeDropdownIfEmpty() {
    if (dropdownOpen && visibleEntries.length === 0 && !showCreateHint) dropdownOpen = false;
  }

  async function runBrowse() {
    if (!isPathLikeQuery(path)) return;
    const generation = ++browseGeneration;
    const result = await settle(() => defaultBrowsePath(path));
    if (generation !== browseGeneration) return;
    if (result.ok) {
      browsedEntries = Array.isArray(result.value.entries) ? result.value.entries : [];
      parentPath = result.value.parentPath || '';
      pathExists = !!result.value.exists;
    } else {
      browsedEntries = [];
      pathExists = false;
    }
    closeDropdownIfEmpty();
  }

  function scheduleBrowse() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runBrowse, 120);
  }

  function handleInput() {
    highlightIndex = -1;
    if (isPathLikeQuery(path)) {
      dropdownOpen = true; // optimistic open — closeDropdownIfEmpty corrects once fetched
      scheduleBrowse();
    } else {
      clearTimeout(debounceTimer);
      dropdownOpen = filterProjectsByQuery(projects, path).length > 0;
    }
  }

  function drillInto(entry: DirEntry | undefined): void {
    if (!entry) return;
    clearTimeout(debounceTimer);
    path = entry.fullPath.endsWith('/') ? entry.fullPath : entry.fullPath + '/';
    highlightIndex = -1;
    dropdownOpen = true;
    runBrowse();
  }

  function selectEntry(entry: DirEntry | undefined): void {
    if (!entry) return;
    clearTimeout(debounceTimer);
    path = entry.fullPath;
    highlightIndex = -1;
    dropdownOpen = false;
  }

  function handleEntryClick(entry: DirEntry): void {
    selectEntry(entry);
    inputEl?.focus();
  }

  function chooseRecent(loc: string): void {
    clearTimeout(debounceTimer);
    path = loc;
    dropdownOpen = false;
    requestAnimationFrame(() => document.getElementById('sessionPath')?.focus());
  }

  function handleRuntimeKeydown(e: KeyboardEvent & { currentTarget: HTMLButtonElement }): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const options = Array.from<HTMLButtonElement>(
      e.currentTarget.parentElement?.querySelectorAll('[role="radio"]:not(:disabled)') || [],
    );
    if (options.length === 0) return;
    e.preventDefault();
    const current = options.indexOf(e.currentTarget);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else {
      const direction = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      next = (Math.max(0, current) + direction + options.length) % options.length;
    }
    const option = options[next];
    if (!option) return;
    option.click();
    option.focus();
  }

  function handleKeydown(e: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (dropdownOpen && visibleEntries.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightIndex = moveHighlight(highlightIndex, visibleEntries.length, 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightIndex = moveHighlight(highlightIndex, visibleEntries.length, -1);
        return;
      }
      const cursorAtEnd = e.currentTarget.selectionStart === path.length;
      if (highlightIndex >= 0 && (e.key === 'Tab' || (e.key === 'ArrowRight' && cursorAtEnd))) {
        e.preventDefault();
        drillInto(visibleEntries[highlightIndex]);
        return;
      }
    }
    if (e.key === 'Enter') {
      if (dropdownOpen && highlightIndex >= 0 && visibleEntries[highlightIndex]) {
        e.preventDefault();
        selectEntry(visibleEntries[highlightIndex]);
        return;
      }
      e.preventDefault();
      onCreate();
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG from icons.js -->

<div
  class="modal-overlay"
  id="modalOverlay"
  class:visible={open}
  class:open
  role="presentation"
  onclick={(e) => {
    if (e.currentTarget === e.target) onClose();
  }}
>
  <div class="modal">
    <div class="modal-sheet-header">
      <button
        class="modal-sheet-back"
        id="modalBackBtn"
        type="button"
        aria-label={t('index.closeNewSession')}
        onclick={onClose}
      >
        <span aria-hidden="true">{@html icon(ArrowLeft, { size: 16 })}</span>
        <span>{t('index.startNewSession')}</span>
      </button>
    </div>
    <h2>{t('index.startNewSession')}</h2>
    <div class="recent-locations" id="recentLocations">
      {#each recent as loc (loc)}
        <button type="button" class="recent-chip" onclick={() => chooseRecent(loc)}>{loc}</button>
      {/each}
    </div>
    {#if runtimes.length > 1 || runtimes.some((option) => !option.available)}
      <fieldset class="runtime-selector">
        <legend>{t('index.runtimeLabel')}</legend>
        <div class="runtime-segments" role="radiogroup" aria-label={t('index.runtimeLabel')}>
          {#each runtimes as option (option.id)}
            <button
              type="button"
              class="runtime-segment"
              class:runtime-segment--selected={runtime === option.id}
              role="radio"
              aria-checked={runtime === option.id}
              tabindex={runtime === option.id ? 0 : -1}
              disabled={!option.available}
              title={!option.available ? option.reason || t('index.runtimeUnavailable') : undefined}
              onclick={() => {
                if (option.available) runtime = option.id;
              }}
              onkeydown={handleRuntimeKeydown}
            >
              <span class="runtime-segment-label">
                {#if option.id === 'pi'}
                  <img class="runtime-segment-mark" src="/pi-icon.svg" alt="" aria-hidden="true" />
                {:else if option.id === 'codex'}
                  <img
                    class="runtime-segment-mark"
                    src="/codex-icon.svg"
                    alt=""
                    aria-hidden="true"
                  />
                {/if}
                <span>{t(`runtime.${option.id}`)}</span>
              </span>
              {#if !option.available}
                <small
                  >{option.reason
                    ? t('index.runtimeUnavailableReason', { reason: option.reason })
                    : t('index.runtimeUnavailable')}</small
                >
              {/if}
            </button>
          {/each}
        </div>
      </fieldset>
    {/if}
    <div class="dir-input-wrap">
      <input
        type="text"
        id="sessionPath"
        placeholder={t('index.sessionPathPlaceholder')}
        autocomplete="off"
        role="combobox"
        aria-expanded={dropdownOpen}
        aria-controls="dirListbox"
        aria-activedescendant={highlightIndex >= 0 ? `dir-opt-${highlightIndex}` : undefined}
        bind:value={path}
        bind:this={inputEl}
        oninput={handleInput}
        onkeydown={handleKeydown}
      />
      {#if dropdownOpen && visibleEntries.length > 0}
        <ul
          class="dir-listbox"
          id="dirListbox"
          role="listbox"
          aria-label={t('index.browseHint')}
          onmousedown={(e) => e.preventDefault()}
        >
          {#each visibleEntries as entry, i (entry.fullPath)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- Keyboard navigation is owned by the input (aria-activedescendant); click is mouse-only. -->
            <li
              id={`dir-opt-${i}`}
              role="option"
              aria-selected={i === highlightIndex}
              class="dir-option"
              class:dir-option--highlighted={i === highlightIndex}
              onmouseenter={() => (highlightIndex = i)}
              onclick={() => handleEntryClick(entry)}
            >
              <span class="dir-option-name">{entry.name}</span>
              {#if !entry.isParent}<span class="dir-option-path">{entry.fullPath}</span>{/if}
            </li>
          {/each}
        </ul>
      {:else if dropdownOpen && showCreateHint}
        <div class="dir-hint" id="dirListbox">{t('index.pathWillBeCreated')}</div>
      {/if}
    </div>
    <div class="new-session-hint" aria-hidden="true">
      <span><kbd>↑↓</kbd>{t('index.dirHintNavigate')}</span>
      <span><kbd>⇥</kbd>{t('index.dirHintEnterDir')}</span>
      <span><kbd>↵</kbd>{t('index.dirHintCreate')}</span>
      <span><kbd>Esc</kbd>{t('index.dirHintClose')}</span>
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" id="cancelBtn" type="button" onclick={onClose}
        >{t('common.cancel')}</button
      >
      <button
        class="btn-primary"
        id="createBtn"
        type="button"
        disabled={creating || !runtime}
        onclick={onCreate}>{t('common.create')}</button
      >
    </div>
    <div class="modal-error" id="modalError">{error}</div>
  </div>
</div>
