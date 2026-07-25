<script lang="ts">
  import { icon, ArrowLeft } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';
  import { sessionsCountLabel } from '../../index/sessions.js';
  import type { Project } from '../../lib/schema';

  type MaybePromise = void | Promise<void>;

  interface Props {
    open?: boolean;
    projects?: ReadonlyArray<Project>;
    error?: string;
    busy?: boolean;
    onClose?: () => void;
    onTrack?: (path: string) => MaybePromise;
    onUntrack?: (path: string) => MaybePromise;
  }

  let {
    open = false,
    projects = [],
    error = '',
    busy = false,
    onClose = () => {},
    onTrack = async () => {},
    onUntrack = async () => {},
  }: Props = $props();

  let query = $state('');
  let addPath = $state('');

  const visibleProjects = $derived(
    projects.filter(
      (project) =>
        !query.trim() ||
        String(project.path || '')
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    ),
  );

  async function trackPath() {
    const path = addPath.trim();
    if (!path) return;
    await onTrack(path);
    addPath = '';
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG from icons.js -->

<div
  class="modal-overlay"
  id="projectsModalOverlay"
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
        id="projectsModalBackBtn"
        type="button"
        aria-label={t('index.closeManageProjects')}
        onclick={onClose}
      >
        <span aria-hidden="true">{@html icon(ArrowLeft, { size: 16 })}</span>
        <span>{t('index.manageTrackedProjects')}</span>
      </button>
    </div>
    <h2>{t('index.manageTrackedProjects')}</h2>
    <p class="projects-modal-intro">{t('index.trackedProjectsHint')}</p>
    <div class="projects-toolbar">
      <input
        type="search"
        id="projectsSearch"
        class="projects-search"
        placeholder={t('index.searchProjects')}
        autocomplete="off"
        bind:value={query}
      />
    </div>
    <div class="projects-list" id="projectsList" data-projects-list>
      {#if projects.length === 0}
        <div class="projects-empty">{t('index.noProjectsFound')}</div>
      {:else if visibleProjects.length === 0}
        <div class="projects-empty" data-projects-no-results>{t('index.noProjectsMatch')}</div>
      {:else}
        {#each visibleProjects as project (project.path)}
          <div class="project-row" data-path={project.path}>
            <button
              type="button"
              class="project-track-toggle"
              class:project-track-toggle--tracked={!!project.tracked}
              disabled={busy}
              aria-pressed={!!project.tracked}
              onclick={() => (project.tracked ? onUntrack(project.path) : onTrack(project.path))}
              >{project.tracked
                ? t('index.removeTrackedProject')
                : t('index.addTrackedProject')}</button
            >
            <div class="project-row-name" title={project.path}><bdi>{project.path}</bdi></div>
            <span class="project-row-count">{sessionsCountLabel(project.sessionCount || 0)}</span>
          </div>
        {/each}
      {/if}
    </div>
    <div class="projects-footer">
      <label class="projects-footer-label" for="projectsAddPath">{t('index.addProjectPath')}</label>
      <input
        type="text"
        id="projectsAddPath"
        placeholder={t('index.sessionPathPlaceholder')}
        bind:value={addPath}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            trackPath();
          }
        }}
      />
      <div class="modal-error" id="projectsModalError">{error}</div>
      <div class="modal-actions">
        <button class="btn-secondary" id="projectsDoneBtn" type="button" onclick={onClose}
          >{t('common.done')}</button
        >
        <button
          class="btn-primary"
          id="projectsAddBtn"
          type="button"
          disabled={busy || !addPath.trim()}
          onclick={trackPath}>{t('index.addProject')}</button
        >
      </div>
    </div>
  </div>
</div>
