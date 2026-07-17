<script>
  import { onMount } from 'svelte';
  import { t } from '../../shared/i18n.js';
  import { icon, X } from '../../shared/icons.js';
  import { formatAnnotationsForPi } from '../../session/annotations/annotation-format.js';
  import { getSelectionInfo, applyHighlights } from '../../session/annotations/annotation-range.js';
  import { sessionRuntime } from '../../session/session-runtime.js';

  // Reactive view state. The notes list, floating "Comment" popover, and note
  // modal are rendered declaratively; the selection/highlight machinery and API
  // calls stay imperative (they touch external scopes + the global selection).
  let annotations = $state([]);
  let popoverVisible = $state(false);
  let popoverTop = $state(0);
  let popoverLeft = $state(0);
  let modalOpen = $state(false);
  let modalQuote = $state('');

  const noteNoun = $derived(
    annotations.length === 1 ? t('annotation.noteOne') : t('annotation.noteMany'),
  );

  // Runtime deps supplied by <SessionPage> via init() (live-only wiring).
  // Config is supplied declaratively by the parent. `api` + the callbacks are
  // stable; `scopes`/`composerEl`/`countEl` are live DOM anchors the parent
  // resolves after mount (so they may arrive a tick later, which the setup
  // $effect below handles). Standalone/tests pass them directly.
  let {
    api = null,
    scopes = [],
    composerEl = null,
    countEl = null,
    onSelectArtifact = null,
    onCreate = null,
    onSend = null,
    onAddToChat = null,
    resolveArtifact = null,
    selectionDelayMs = 250,
  } = $props();
  const FLASH_DURATION_MS = 1200;

  let pending = null; // selection info awaiting a note
  let observer = null;
  let selectionTimer = null;
  // Monotonic guard: a slow in-flight list() must not clobber newer state set by
  // a later refresh, an optimistic create, or an SSE snapshot.
  let loadSeq = 0;

  let listRootEl;
  let popoverEl;
  let modalEl;
  let noteInputEl;

  // ── highlight (re)application ─────────────────────────────────────────────
  function reapply() {
    observer?.disconnect();
    for (const scope of activeScopes) {
      applyHighlights(scope, annotations, { documentImpl: document });
    }
    observer?.takeRecords?.();
    if (observer) {
      for (const scope of activeScopes) observer.observe(scope, { childList: true, subtree: true });
    }
  }

  function updateCount() {
    if (!countEl) return;
    countEl.textContent = String(annotations.length);
    countEl.hidden = annotations.length === 0;
  }

  // The notes list renders reactively from `annotations`; render() handles the
  // imperative side effects (highlights + the tab count badge).
  function render() {
    reapply();
    updateCount();
  }

  function setAnnotations(list) {
    loadSeq += 1; // supersede any in-flight refresh
    annotations = Array.isArray(list) ? list : [];
    render();
  }

  async function refresh() {
    if (!api) return;
    const seq = loadSeq + 1;
    loadSeq = seq;
    try {
      const list = await api.list();
      if (seq !== loadSeq) return; // a newer update superseded this load
      annotations = Array.isArray(list) ? list : [];
      render();
    } catch {
      /* keep current */
    }
  }

  function sendToPi() {
    if (!composerEl || annotations.length === 0) return;
    composerEl.value = formatAnnotationsForPi(annotations, { resolveArtifact });
    composerEl.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof onSend === 'function') onSend();
    composerEl.focus();
  }

  async function deleteNote(id) {
    if (!id) return;
    setAnnotations(annotations.filter((a) => a.id !== id)); // optimistic
    try {
      await api?.remove(id);
    } finally {
      refresh();
    }
  }

  // ── popover / modal ───────────────────────────────────────────────────────
  function hidePopover() {
    popoverVisible = false;
  }

  function showCommentButton(rect) {
    popoverTop = Math.max(8, rect.bottom + 10);
    popoverLeft = Math.min(Math.max(8, rect.left), window.innerWidth - 150);
    popoverVisible = true;
  }

  function openNoteInput() {
    if (!pending) return;
    hidePopover();
    modalQuote = `"${String(pending.text || '')
      .replace(/\s+/g, ' ')
      .trim()}"`;
    modalOpen = true;
    // Toggle the attribute synchronously so focus() lands within the tap gesture
    // (mobile keyboard) before Svelte's async flush sets the same value.
    if (modalEl) modalEl.hidden = false;
    if (noteInputEl) {
      noteInputEl.value = '';
      noteInputEl.focus();
    }
  }

  function closeNote() {
    modalOpen = false;
    if (modalEl) modalEl.hidden = true;
    pending = null;
  }

  function addToChat() {
    if (!pending) return;
    const note = noteInputEl ? noteInputEl.value.trim() : '';
    const original = pending.text;
    pending = null;
    modalOpen = false;
    if (modalEl) modalEl.hidden = true;
    window.getSelection?.()?.removeAllRanges?.();
    if (typeof onAddToChat === 'function') onAddToChat({ original, note });
  }

  async function saveComment() {
    if (!pending) return;
    const note = noteInputEl ? noteInputEl.value.trim() : '';
    const optimistic = {
      id: `tmp-${Date.now()}`,
      anchorId: pending.anchorId,
      startOffset: pending.start,
      endOffset: pending.end,
      kind: 'comment',
      text: note,
      original: pending.text,
      source: 'local',
      createdAt: Date.now(),
    };
    const payload = {
      anchorId: optimistic.anchorId,
      startOffset: optimistic.startOffset,
      endOffset: optimistic.endOffset,
      kind: 'comment',
      text: note,
      original: optimistic.original,
    };
    pending = null;
    modalOpen = false;
    if (modalEl) modalEl.hidden = true;
    window.getSelection?.()?.removeAllRanges?.();
    setAnnotations([...annotations, optimistic]); // optimistic; bumps the load guard
    if (typeof onCreate === 'function') onCreate();
    try {
      await api.create(payload);
    } finally {
      refresh();
    }
  }

  // ── selection detection ───────────────────────────────────────────────────
  function maybeShowFromSelection() {
    if (modalOpen) return;
    if (popoverEl && popoverEl.contains(document.activeElement)) return;
    const sel = window.getSelection?.();
    const info = getSelectionInfo(sel, { documentImpl: document });
    if (!info || !activeScopes.some((s) => s.contains(info.anchorEl))) {
      if (popoverVisible) hidePopover();
      return;
    }
    pending = info;
    let rect = { bottom: 0, left: 0 };
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch {
      /* default */
    }
    showCommentButton(rect);
  }

  function onMouseUp(e) {
    if (popoverEl?.contains(e.target) || modalEl?.contains(e.target)) return;
    maybeShowFromSelection();
  }

  function onSelectionChange() {
    if (window.clearTimeout) window.clearTimeout(selectionTimer);
    if (window.setTimeout)
      selectionTimer = window.setTimeout(maybeShowFromSelection, selectionDelayMs);
    else maybeShowFromSelection();
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (modalOpen) closeNote();
    else if (popoverVisible) hidePopover();
  }

  // ── list / popover / modal delegated handlers (a11y: no inline div onclick) ──
  function onListClick(e) {
    const del = e.target.closest?.('[data-action="delete"]');
    if (del) {
      const item = del.closest('.annotation-item');
      deleteNote(item?.dataset.annotationId);
      return;
    }
    if (e.target.closest?.('[data-action="send-to-pi"]')) {
      sendToPi();
      return;
    }
    const item = e.target.closest?.('.annotation-item');
    if (item) {
      const anchorId = item.dataset.anchorId || '';
      if (anchorId.indexOf('artifact-') === 0 && onSelectArtifact) {
        onSelectArtifact(anchorId.slice('artifact-'.length));
      }
      const anchor = document.getElementById(anchorId);
      if (anchor) {
        anchor.scrollIntoView({ block: 'center', behavior: 'smooth' });
        anchor.classList.add('annotation-flash');
        window.setTimeout(() => anchor.classList.remove('annotation-flash'), FLASH_DURATION_MS);
      }
    }
  }

  // Active scopes after filtering out any null DOM anchors the parent hasn't
  // resolved yet.
  const activeScopes = $derived((Array.isArray(scopes) ? scopes : []).filter(Boolean));

  // (Re)load + observe whenever the api or the resolved scopes change. Document
  // listeners attach once in onMount; the handlers read the reactive config, so
  // they no-op until a scope/api is present.
  $effect(() => {
    if (!api || activeScopes.length === 0) return;
    if (window.MutationObserver && !observer) {
      observer = new window.MutationObserver(() => {
        if (window.requestAnimationFrame) window.requestAnimationFrame(reapply);
        else reapply();
      });
    }
    refresh();
  });

  onMount(() => {
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown);
    // Relocate the popover + note modal to <body> so their fixed positioning is
    // viewport-relative (the right sidebar uses transforms, which would otherwise
    // become their containing block). Svelte keeps patching them by reference.
    document.body.appendChild(popoverEl);
    document.body.appendChild(modalEl);

    listRootEl.addEventListener('click', onListClick);
    popoverEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection alive on desktop
    popoverEl.addEventListener('click', (e) => {
      if (e.target.closest?.('[data-action="start-comment"]')) openNoteInput();
    });
    modalEl.addEventListener('click', (e) => {
      const action = e.target.closest?.('[data-action]')?.dataset.action;
      if (action === 'save-note') saveComment();
      else if (action === 'add-to-chat') addToChat();
      else if (action === 'cancel-note') closeNote();
    });

    sessionRuntime.annotations = { setAnnotations, reapply, refresh };

    return () => {
      observer?.disconnect();
      if (window.clearTimeout) window.clearTimeout(selectionTimer);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
      // eslint-disable-next-line svelte/no-dom-manipulating -- imperatively-created popover, not a Svelte-rendered node
      popoverEl?.remove();
      // eslint-disable-next-line svelte/no-dom-manipulating -- imperatively-created modal, not a Svelte-rendered node
      modalEl?.remove();
      sessionRuntime.annotations = null;
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG markup -->
<div id="annotation-list-host" class="annotation-list-host" bind:this={listRootEl}>
  {#if annotations.length === 0}
    <div class="annotation-empty">{t('annotation.empty')}</div>
  {:else}
    <div class="annotation-list">
      {#each annotations as a (a.id)}
        <div class="annotation-item" data-annotation-id={a.id} data-anchor-id={a.anchorId}>
          <button
            type="button"
            class="annotation-delete"
            data-action="delete"
            title={t('annotation.deleteNote')}>{@html icon(X, { size: 14 })}</button
          >
          {#if a.original}<div class="annotation-quote">{a.original}</div>{/if}
          {#if a.text}<div class="annotation-note">{a.text}</div>{/if}
        </div>
      {/each}
    </div>
    <div class="annotation-footer">
      <button type="button" class="annotation-send" data-action="send-to-pi"
        >{t('annotation.sendNotesToPi', { count: annotations.length, noun: noteNoun })}</button
      >
    </div>
  {/if}
</div>

<div
  class="annotation-popover"
  bind:this={popoverEl}
  hidden={!popoverVisible}
  style:top={`${popoverTop}px`}
  style:left={`${popoverLeft}px`}
  style:position="fixed"
>
  <button type="button" class="annotation-pop-btn" data-action="start-comment"
    >{t('annotation.comment')}</button
  >
</div>

<div class="annotation-note-modal" bind:this={modalEl} hidden={!modalOpen}>
  <div class="annotation-note-backdrop" data-action="cancel-note"></div>
  <div
    class="annotation-note-card"
    role="dialog"
    aria-modal="true"
    aria-label={t('annotation.addNote')}
  >
    <div class="annotation-note-quote">{modalQuote}</div>
    <textarea
      class="annotation-note-input"
      bind:this={noteInputEl}
      placeholder={t('annotation.addNotePlaceholder')}
      rows="3"
    ></textarea>
    <div class="annotation-note-actions">
      <button type="button" class="annotation-note-cancel" data-action="cancel-note"
        >{t('annotation.cancel')}</button
      >
      <button type="button" class="annotation-note-addchat" data-action="add-to-chat"
        >{t('annotation.addToChat')}</button
      >
      <button type="button" class="annotation-note-save" data-action="save-note"
        >{t('annotation.saveNote')}</button
      >
    </div>
  </div>
</div>
