<script>
  import { t } from '../../shared/i18n.js';
  import {
    defaultBrowsePath,
    filterProjectsByQuery,
    isPathLikeQuery,
    moveHighlight,
    projectsToEntries,
    withParentEntry,
  } from '../../index/dir-browse.js';
  import { defaultFetchProjects } from '../../index/sessions.js';

  let {
    open = false,
    recent = [],
    path = $bindable(''),
    creating = false,
    error = '',
    dropdownOpen = $bindable(false),
    onClose = () => {},
    onCreate = () => {},
  } = $props();

  let inputEl;
  let projects = $state([]);
  let projectsLoaded = false;
  let browsedEntries = $state([]);
  let parentPath = $state('');
  let pathExists = $state(true);
  let highlightIndex = $state(-1);
  let browseGeneration = 0;
  let debounceTimer = null;

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
    try {
      const response = await defaultFetchProjects();
      projects = Array.isArray(response.projects) ? response.projects : [];
    } catch {
      projects = [];
    }
  }

  $effect(() => {
    if (open) loadProjectsOnce();
  });

  function closeDropdownIfEmpty() {
    if (dropdownOpen && visibleEntries.length === 0 && !showCreateHint) dropdownOpen = false;
  }

  async function runBrowse() {
    if (!isPathLikeQuery(path)) return;
    const generation = ++browseGeneration;
    try {
      const response = await defaultBrowsePath(path);
      if (generation !== browseGeneration) return;
      browsedEntries = Array.isArray(response.entries) ? response.entries : [];
      parentPath = response.parentPath || '';
      pathExists = !!response.exists;
    } catch {
      if (generation !== browseGeneration) return;
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

  function drillInto(entry) {
    if (!entry) return;
    clearTimeout(debounceTimer);
    path = entry.fullPath.endsWith('/') ? entry.fullPath : entry.fullPath + '/';
    highlightIndex = -1;
    dropdownOpen = true;
    runBrowse();
  }

  function selectEntry(entry) {
    if (!entry) return;
    clearTimeout(debounceTimer);
    path = entry.fullPath;
    highlightIndex = -1;
    dropdownOpen = false;
  }

  function handleEntryClick(entry) {
    selectEntry(entry);
    inputEl?.focus();
  }

  function chooseRecent(loc) {
    clearTimeout(debounceTimer);
    path = loc;
    dropdownOpen = false;
    requestAnimationFrame(() => document.getElementById('sessionPath')?.focus());
  }

  function handleKeydown(e) {
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
        <span aria-hidden="true">←</span>
        <span>{t('index.startNewSession')}</span>
      </button>
    </div>
    <h2>{t('index.startNewSession')}</h2>
    <div class="recent-locations" id="recentLocations">
      {#each recent as loc (loc)}
        <button type="button" class="recent-chip" onclick={() => chooseRecent(loc)}>{loc}</button>
      {/each}
    </div>
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
        disabled={creating}
        onclick={onCreate}>{t('common.create')}</button
      >
    </div>
    <div class="modal-error" id="modalError">{error}</div>
  </div>
</div>
