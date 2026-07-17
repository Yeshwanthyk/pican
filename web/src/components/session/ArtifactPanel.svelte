<script>
  import { onMount } from 'svelte';
  import { marked } from 'marked';
  import { safeMarkedParse } from '../../session/render/markdown.js';
  import { getSessionModel } from '../../session/session-context.js';
  import { collectArtifacts } from '../../session/artifacts/artifact-registry.js';
  import {
    filterArtifacts,
    readArtifactSettings,
    ARTIFACT_SETTING_KEYS,
  } from '../../session/artifacts/artifact-filter.js';
  import { t } from '../../shared/i18n.js';
  import { copyToClipboard } from '../../shared/clipboard.js';
  import { sessionRuntime } from '../../session/session-runtime.js';

  // `highlight`/`renderMarkdown` are injectable for tests; in the live app the
  // component lazy-loads highlight.js itself and renders markdown via marked.
  let { highlight = null, renderMarkdown = null } = $props();

  // The panel collects artifacts straight from the shared reactive model: on
  // mount and whenever entries change (live reload), it re-runs collection +
  // filtering. Standalone (tests, no context) the model is undefined and the
  // panel is driven imperatively via the sessionRuntime.artifacts.setArtifacts
  // handle instead.
  const model = getSessionModel();
  const COPIED_RESET_MS = 1500;
  // Bumped by the cross-tab `storage` listener so `collected` re-reads the
  // artifact settings (enable/include filter) without a reload.
  let settingsTick = $state(0);

  // Standalone/imperative mode (tests, no shared model): artifacts pushed in via
  // sessionRuntime.artifacts.setArtifacts. In live mode `collected` drives them.
  let imperative = $state(null);
  let pickedId = $state('');
  // Preview is opt-in (click-to-run): never auto-execute artifact content.
  let previewing = $state(false);
  let loadedHljs = $state(null);

  // Collected artifacts from the shared model (live only; null standalone).
  // Recomputes when entries change (live reload) or the settings tick bumps.
  const collected = $derived.by(() => {
    if (!model) return null;
    settingsTick;
    const all = collectArtifacts(model.entries);
    const settings = readArtifactSettings(window.localStorage);
    const { visible, hiddenCount: hidden } = filterArtifacts(all, settings);
    return { visible, hiddenCount: hidden, enabled: settings.enabled };
  });

  const artifacts = $derived(collected ? collected.visible : (imperative?.visible ?? []));
  const hiddenCount = $derived(collected ? collected.hiddenCount : (imperative?.hiddenCount ?? 0));
  // Keep the user's pick while it's still in the list; otherwise default to first.
  const selectedId = $derived(
    artifacts.some((a) => a.id === pickedId) ? pickedId : (artifacts[0]?.id ?? ''),
  );

  const selected = $derived(artifacts.find((a) => a.id === selectedId) || null);
  const noun = $derived(hiddenCount === 1 ? t('artifact.nounOne') : t('artifact.nounMany'));

  const effectiveHighlight = $derived(
    highlight ||
      (loadedHljs
        ? (code, lang) => {
            try {
              return lang && loadedHljs.getLanguage(lang)
                ? loadedHljs.highlight(code, { language: lang }).value
                : loadedHljs.highlightAuto(code).value;
            } catch {
              return null;
            }
          }
        : null),
  );

  // Highlighted HTML for the selected artifact's source, or null (→ plain text +
  // data-highlight-pending so the session's lazy highlighter can finish later).
  const codeHtml = $derived.by(() => {
    const a = selected;
    if (!a || !effectiveHighlight) return null;
    try {
      return effectiveHighlight(a.content, a.lang);
    } catch {
      return null;
    }
  });

  const renderMd = (text) =>
    renderMarkdown ? renderMarkdown(text) : safeMarkedParse(text, { marked });

  function previewSrcdoc(a) {
    const csp =
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'";
    return (
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `</head><body>${a.content}</body></html>`
    );
  }

  const previewLabel = $derived.by(() => {
    if (previewing) return t('artifact.showSource');
    return selected?.previewType === 'markdown' ? t('artifact.preview') : t('artifact.runPreview');
  });

  async function copyArtifactSource(textValue, button) {
    const ok = await copyToClipboard(textValue);
    if (ok && button) {
      const original = button.textContent;
      button.textContent = t('common.copied');
      button.classList.add('copied');
      window.setTimeout(() => {
        button.textContent = original;
        button.classList.remove('copied');
      }, COPIED_RESET_MS);
    }
    return ok;
  }

  function download(a) {
    const blob = new Blob([a.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = a.filePath ? a.title : `${a.id}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function setArtifacts(next, { hiddenCount: hidden = 0 } = {}) {
    imperative = {
      visible: Array.isArray(next) ? next : [],
      hiddenCount: Number.isFinite(hidden) && hidden > 0 ? hidden : 0,
    };
  }

  function selectArtifact(id) {
    if (!artifacts.some((a) => a.id === id)) return;
    if (id !== pickedId) previewing = false;
    pickedId = id;
  }

  // Hide the Artifacts tab entirely when the feature is disabled; if it was the
  // active tab, fall back to Scratchpad so the user isn't left on a blank pane.
  function applyArtifactsEnabled(enabled) {
    const tab = document.getElementById('right-tab-artifacts');
    if (!tab) return;
    tab.hidden = !enabled;
    if (!enabled && tab.classList.contains('active')) {
      document.getElementById('right-tab-scratchpad')?.click();
    }
  }

  // Whenever the resolved selection changes (user pick or a list change that
  // re-defaults it), drop back to the source view.
  let lastSelectedId = '';
  $effect(() => {
    if (selectedId !== lastSelectedId) {
      lastSelectedId = selectedId;
      previewing = false;
    }
  });

  // Live-only tab chrome: reflect enabled state + the artifact count badge.
  // Writes DOM only, so it depends purely on `collected`.
  $effect(() => {
    const c = collected;
    if (!c) return;
    applyArtifactsEnabled(c.enabled);
    const countEl = document.getElementById('artifact-tab-count');
    if (countEl) {
      countEl.textContent = String(c.visible.length);
      countEl.hidden = c.visible.length === 0;
    }
  });

  onMount(() => {
    if (!highlight) {
      import('highlight.js')
        .then(({ default: loaded }) => {
          loadedHljs = loaded;
        })
        .catch(() => {});
    }
    // Reflect artifact-setting changes made on the /settings page (in another
    // tab) without a reload. The `storage` event fires only in other documents,
    // so this won't double-fire for changes originating in this same tab. A null
    // key means storage was cleared — re-read defaults.
    const onStorage = (e) => {
      if (e.key === null || ARTIFACT_SETTING_KEYS.includes(e.key)) settingsTick += 1;
    };
    if (model) window.addEventListener('storage', onStorage);
    sessionRuntime.artifacts = {
      setArtifacts,
      selectArtifact,
      render: () => {},
      getSelectedId: () => selectedId,
      getArtifact: (id) => artifacts.find((a) => a.id === id) || null,
      getCount: () => artifacts.length,
    };
    return () => {
      if (model) window.removeEventListener('storage', onStorage);
      sessionRuntime.artifacts = null;
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div id="artifact-panel-host" class="artifact-panel-host">
  <div class="artifact-panel">
    {#if artifacts.length === 0}
      {#if hiddenCount > 0}
        <div class="artifact-empty">
          {@html t('artifact.emptyHidden', { count: hiddenCount, noun })}
        </div>
      {:else}
        <div class="artifact-empty">{t('artifact.emptyNone')}</div>
      {/if}
    {:else}
      <div class="artifact-list" role="tablist">
        {#each artifacts as a (a.id)}
          <button
            type="button"
            class="artifact-list-item"
            class:active={a.id === selectedId}
            role="tab"
            aria-selected={a.id === selectedId}
            data-artifact-id={a.id}
            onclick={() => selectArtifact(a.id)}
          >
            <span class="artifact-item-title">{a.title}</span>
            {#if a.lang}<span class="artifact-item-lang">{a.lang}</span>{/if}
            {#if a.kind === 'preview'}<span class="artifact-badge">preview</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    <div class="artifact-view">
      {#if selected}
        <div class="artifact-view-header">
          <span class="artifact-view-title">{selected.title}</span>
          <div class="artifact-view-actions">
            {#if selected.kind === 'preview'}
              <button
                type="button"
                class="artifact-action"
                class:active={previewing}
                data-action="toggle-preview"
                onclick={() => (previewing = !previewing)}>{previewLabel}</button
              >
            {/if}
            <button
              type="button"
              class="artifact-action"
              data-action="copy"
              title={t('artifact.copySource')}
              onclick={(e) => copyArtifactSource(selected.content, e.currentTarget)}
              >{t('artifact.copy')}</button
            >
            <button
              type="button"
              class="artifact-action"
              data-action="download"
              title={t('artifact.download')}
              onclick={() => download(selected)}>{t('artifact.download')}</button
            >
          </div>
        </div>
        {#if selected.kind === 'preview' && previewing}
          {#if selected.previewType === 'markdown'}
            <div class="artifact-view-body">
              <div class="artifact-markdown markdown-content">
                {@html renderMd(selected.content)}
              </div>
            </div>
          {:else}
            <div class="artifact-view-body">
              <iframe
                class="artifact-preview"
                sandbox="allow-scripts"
                referrerpolicy="no-referrer"
                title={`Preview: ${selected.title}`}
                srcdoc={previewSrcdoc(selected)}
              ></iframe>
            </div>
          {/if}
        {:else}
          <div class="artifact-view-body">
            <pre class="artifact-source" id={`artifact-${selected.id}`}>{#if codeHtml !== null}<code
                  class="hljs">{@html codeHtml}</code
                >{:else}<code
                  class="hljs"
                  data-highlight-pending
                  data-lang={selected.lang || undefined}>{selected.content}</code
                >{/if}</pre>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
