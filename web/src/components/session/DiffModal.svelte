<script lang="ts">
  // Working-tree diff review modal. Lazy-loads @pierre/diffs (a large,
  // shadow-DOM diff renderer) only when opened, fetches the session's
  // uncommitted diff, and renders a split/unified CodeView.
  import { Effect } from 'effect';
  import { tick, onMount } from 'svelte';
  import type {
    CodeView,
    CodeViewDiffItem,
    CodeViewOptions,
    FileContents,
    FileDiffMetadata,
  } from '@pierre/diffs';
  import { runSync } from '../../lib/runtime.js';
  import * as Http from '../../lib/http.js';
  import { runPromise } from '../../lib/runtime.js';
  import { GitDiffSchema } from '../../lib/schema.js';
  import FullScreenSheet from './FullScreenSheet.svelte';
  import { t } from '../../shared/strings.js';
  import { ChevronDown, ChevronRight, iconNode } from '../../shared/icons.js';

  let { open = $bindable(false), sessionId = '' }: { open?: boolean; sessionId?: string } =
    $props();

  let loading = $state(false);
  let errorMsg = $state('');
  let emptyState = $state(''); // '', 'empty', 'notrepo'
  let layout = $state<'split' | 'unified'>('split');
  // Per-file collapse state. The Set holds collapsed file names; the count
  // mirrors its size as $state so the "Collapse all" toggle label is reactive
  // (a raw Set's mutations don't notify Svelte). fileCount is the total once
  // the diff has loaded — drives the "all collapsed?" check. Set is a plain,
  // non-reactive collection here: we don't iterate it in any template, only
  // call has()/add()/delete() imperatively from render callbacks.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- imperative storage; collapsedCount carries the reactivity
  let collapsedFiles = new Set<string>();
  let collapsedCount = $state(0);
  let fileCount = $state(0);
  const allCollapsed = $derived(fileCount > 0 && collapsedCount >= fileCount);

  // Matches FullScreenSheet's SHEET_BREAKPOINT. Drives where the toolbar
  // renders (header on desktop, second row in body on mobile) and feeds the
  // mobile-only CSS pumped into the shadow DOM via unsafeCSS.
  const MOBILE_QUERY = '(max-width: 900px)';
  let isMobile = $state(false);

  // Imperative, non-reactive handles (DOM-heavy; kept out of $state).
  let viewport: HTMLElement | null = null; // container node, owned by CodeView (via the action)
  let diffsMod: typeof import('@pierre/diffs') | null = null;
  let codeView: CodeView<undefined> | null = null;
  // The full CodeView options. setOptions REPLACES (not merges), so every
  // setOptions call must pass the complete object.
  let codeViewOptions: CodeViewOptions<undefined> | null = null;
  let fileDiffs: Map<string, FileDiffMetadata> | null = null;
  let themeObserver: MutationObserver | null = null;
  // CodeView.updateItem only re-renders when the item's `version` changes, so
  // every (re)built item gets a fresh monotonic version.
  let itemVersion = 0;

  onMount(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const sync = (): void => {
      isMobile = mql.matches;
    };
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  });

  // The mount container is driven by an action rather than bind:this: the
  // action mounts when <FullScreenSheet> reveals its body (open) and is
  // destroyed when it tears down (close), which is exactly the diff lifecycle.
  // CodeView fully owns this node's subtree, so Svelte never reconciles it.
  function mountDiff(node: HTMLElement): { destroy(): void } {
    viewport = node;
    init();
    return {
      destroy() {
        teardown();
      },
    };
  }

  // Resolve `promise` but reject with a stage-labelled timeout if it stalls, so
  // a hang surfaces (in the UI and the console) as a specific step rather than
  // an opaque "Loading diff…". The stage names are logged for support.
  function withStage<T>(stage: string, promise: Promise<T>, ms: number): Promise<T> {
    const started = performance.now();
    console.info(`[diff] ${stage}: start`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`__diff_timeout__:${stage}`);
        reject(err);
      }, ms);
    });
    return Promise.race([promise, timeout]).then(
      (value) => {
        clearTimeout(timer);
        console.info(`[diff] ${stage}: done in ${Math.round(performance.now() - started)}ms`);
        return value;
      },
      (err: unknown) => {
        clearTimeout(timer);
        console.error(
          `[diff] ${stage}: failed after ${Math.round(performance.now() - started)}ms`,
          err,
        );
        throw err;
      },
    );
  }

  function init(): void {
    loading = true;
    errorMsg = '';
    emptyState = '';
    void Promise.all([
      withStage('renderer', import('@pierre/diffs'), 30000),
      withStage(
        'diff',
        runPromise(Http.get('/api/git/diff?id=' + encodeURIComponent(sessionId), GitDiffSchema)),
        25000,
      ),
    ]).then(
      async ([mod, diffRes]) => {
        diffsMod = mod;
        if (!diffRes.isRepo) {
          emptyState = 'notrepo';
          loading = false;
          return;
        }
        const files = mod.parsePatchFiles(diffRes.diff || '').flatMap((p) => p.files);
        if (files.length === 0) {
          emptyState = 'empty';
          loading = false;
          return;
        }
        fileDiffs = new Map(files.map((f) => [f.name, f]));
        fileCount = files.length;
        loading = false;
        // Let the container un-hide before CodeView measures its height.
        await tick();
        buildCodeView(files);
      },
      (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        errorMsg = msg.startsWith('__diff_timeout__')
          ? `${t('diff.timeout')} (${msg.split(':')[1] || ''})`
          : msg;
        loading = false;
      },
    );
  }

  function teardown(): void {
    themeObserver?.disconnect();
    themeObserver = null;
    runSync(
      Effect.try({ try: () => codeView?.cleanUp(), catch: () => undefined }).pipe(
        Effect.orElseSucceed(() => undefined),
      ),
    );
    viewport = null;
    codeView = null;
    codeViewOptions = null;
    fileDiffs = null;
    loading = false;
    errorMsg = '';
    emptyState = '';
    collapsedFiles = new Set<string>();
    collapsedCount = 0;
    fileCount = 0;
  }

  // Built-in themes with a light canvas; every other theme (including any
  // future community theme not listed here) renders the diff with the dark
  // pierre bundle, so this only needs the light ones.
  const LIGHT_THEMES = ['light', 'catppuccin-latte', 'github-light'];

  function currentThemeType(): 'light' | 'dark' {
    return LIGHT_THEMES.includes(document.documentElement.dataset.theme ?? '') ? 'light' : 'dark';
  }

  function buildCodeView(files: FileDiffMetadata[]): void {
    const viewportNode = viewport;
    const module = diffsMod;
    if (!module || !viewportNode) return;
    const { CodeView } = module;
    const options: CodeViewOptions<undefined> = {
      diffStyle: layout,
      themeType: currentThemeType(),
      // pierre-dark / pierre-light are the library's bundled default themes;
      // other names (e.g. github-*) aren't shipped and fall back to white.
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      lineHoverHighlight: 'both',
      stickyHeaders: true,
      renderHeaderPrefix: (fileDiff: FileContents | FileDiffMetadata) =>
        buildCollapseToggle(fileDiff),
    };
    codeViewOptions = options;
    codeView = new CodeView(options);
    codeView.setup(viewportNode);
    codeView.setItems(files.map((f) => makeItem(f)));
    codeView.render();

    // Live-follow the app theme: re-theme the diff when the user switches it.
    themeObserver = new MutationObserver(() => applyOptions({ themeType: currentThemeType() }));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  // setOptions replaces the whole options object, so always merge into the
  // retained codeViewOptions and pass the complete object.
  function applyOptions(patch: Partial<CodeViewOptions<undefined>>): void {
    if (!codeView || !codeViewOptions) return;
    codeViewOptions = { ...codeViewOptions, ...patch };
    codeView.setOptions(codeViewOptions);
    codeView.render();
  }

  function makeItem(file: FileDiffMetadata): CodeViewDiffItem<undefined> {
    return {
      id: file.name,
      type: 'diff',
      fileDiff: file,
      collapsed: collapsedFiles.has(file.name),
      version: ++itemVersion,
    };
  }

  // Chevron rendered as the file-header prefix. Lives inside the diffs shadow
  // DOM but we attach a real click listener directly on the button; the
  // library calls renderHeaderPrefix again on each updateItem, so the chevron
  // icon stays in sync after toggleFileCollapsed.
  function buildCollapseToggle(fileDiff: FileContents | FileDiffMetadata): HTMLButtonElement {
    const collapsed = collapsedFiles.has(fileDiff.name);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', collapsed ? t('diff.expandFile') : t('diff.collapseFile'));
    btn.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;' +
      'background:transparent;border:0;cursor:pointer;color:var(--muted,#858a96);padding:0;' +
      'margin-right:2px;border-radius:3px;flex-shrink:0;';
    btn.appendChild(iconNode(collapsed ? ChevronRight : ChevronDown, { size: 14 }));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFileCollapsed(fileDiff.name);
    });
    return btn;
  }

  function setFileCollapsed(fileName: string, collapsed: boolean): void {
    if (collapsed) collapsedFiles.add(fileName);
    else collapsedFiles.delete(fileName);
    collapsedCount = collapsedFiles.size;
  }

  function toggleFileCollapsed(fileName: string): void {
    setFileCollapsed(fileName, !collapsedFiles.has(fileName));
    refreshItem(fileName);
  }

  function toggleAllCollapsed(): void {
    if (!fileDiffs) return;
    const names = [...fileDiffs.keys()];
    const collapse = !names.every((n) => collapsedFiles.has(n));
    for (const name of names) setFileCollapsed(name, collapse);
    for (const name of names) refreshItem(name);
  }

  function refreshItem(fileName: string): void {
    const file = fileDiffs?.get(fileName);
    if (!file || !codeView) return;
    codeView.updateItem(makeItem(file));
  }

  function setLayout(next: 'split' | 'unified'): void {
    if (next === layout) return;
    layout = next;
    applyOptions({ diffStyle: next });
  }
</script>

{#snippet toolbar()}
  <!-- Lives in the sheet header on desktop and as a second row in the body
       on mobile (a phone-width header can't hold "← Diff" plus Split/Unified
       + Collapse all without crushing the back button). -->
  <div class="diff-toolbar">
    <div class="diff-toggle" role="group" aria-label={t('diff.title')}>
      <button
        type="button"
        class="diff-toggle-btn"
        class:active={layout === 'split'}
        onclick={() => setLayout('split')}>{t('diff.split')}</button
      >
      <button
        type="button"
        class="diff-toggle-btn"
        class:active={layout === 'unified'}
        onclick={() => setLayout('unified')}>{t('diff.unified')}</button
      >
    </div>
    <button
      type="button"
      class="diff-toolbar-btn"
      disabled={fileCount === 0}
      onclick={toggleAllCollapsed}
    >
      {allCollapsed ? t('diff.expandAll') : t('diff.collapseAll')}
    </button>
  </div>
{/snippet}

<FullScreenSheet
  bind:open
  title={t('diff.title')}
  backdropClass="diff-sheet-backdrop"
  panelClass="diff-sheet-panel"
  bodyClass="diff-sheet-body"
  headerExtra={isMobile ? null : toolbar}
>
  {#if isMobile}
    {@render toolbar()}
  {/if}

  {#if loading}
    <div class="diff-status">{t('diff.loading')}</div>
  {:else if errorMsg}
    <div class="diff-status diff-status-error">{errorMsg}</div>
  {:else if emptyState === 'notrepo'}
    <div class="diff-status">{t('diff.notRepo')}</div>
  {:else if emptyState === 'empty'}
    <div class="diff-status">{t('diff.empty')}</div>
  {/if}

  <div class="diff-codeview" use:mountDiff hidden={loading || !!errorMsg || !!emptyState}></div>
</FullScreenSheet>

<!-- Styles live in internal/ui/embedded/styles/session.css (the app loads global
     stylesheets, not Svelte-scoped <style> blocks — see ModelUsageModal). -->
