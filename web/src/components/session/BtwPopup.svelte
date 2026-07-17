<script>
  // The "btw" floating, draggable, resizable scratch-chat opened from the git
  // bar (#pi-btw-button, in <ChatComposer>). Its own per-parent btw session is
  // persisted server-side and synced over SSE. The transcript renders reactively;
  // drag/resize/SSE/status-polling/submit stay imperative. Live-only — never in
  // the export bundle. See docs/sequence-flows/btw.md.
  import { onMount } from 'svelte';
  import { getSpinnerConfig } from '../../session/live/chat-preview.js';
  import { t } from '../../shared/i18n.js';
  import { icon, X, Square, Send } from '../../shared/icons.js';
  import {
    enableBtwDrag,
    loadBtwGeometry,
    persistBtwResize,
    placeBtwInitial,
    saveBtwGeometry,
  } from './btw-geometry.js';
  import {
    closeBtwEventSource,
    setupBtwParentEvents,
    setupBtwSessionEvents,
  } from './btw-events.js';
  import { btwContentText, createBtwMarkdownRenderer, renderBtwEntryParts } from './btw-render.js';

  let { cwd = '', parentId = '' } = $props();

  const GLOBAL_PARENT = '__global__';
  // After a send, ignore an "idle" status for this long so the spinner doesn't
  // flicker off before the worker has actually started.
  const IDLE_GRACE_MS = 3000;
  const STATUS_POLL_MS = 1500;

  let open = $state(false);
  let entries = $state([]);
  let pendingUser = $state(null);
  let streamingText = $state('');
  let running = $state(false);
  let sessionId = $state('');
  let spinnerChar = $state('');
  let spinnerStyle = $state('');

  let winEl, headerEl, bodyEl, inputEl;
  // Non-reactive runtime handles.
  let btnEl = null;
  let eventSource = null;
  let globalSource = null;
  let statusTimer = null;
  let spinnerTimer = null;
  let spinnerFrame = 0;
  let spinnerConfig = null;
  let lastSentAt = 0;
  let nearBottom = true;

  const parentTopic = () => parentId || GLOBAL_PARENT;
  const isMobile = () =>
    !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  const doFetch = (...args) => window.fetch(...args);
  const toHtml = createBtwMarkdownRenderer({ documentImpl: document });
  const renderEntryParts = (entry) => renderBtwEntryParts(entry, { toHtml });

  const renderedEntries = $derived(entries.map(renderEntryParts).filter(Boolean));
  const isEmpty = $derived(
    renderedEntries.length === 0 && !pendingUser && !(running || streamingText),
  );

  const loadGeom = () => loadBtwGeometry({ storage: window.localStorage });
  const saveGeom = (patch) => saveBtwGeometry(patch, { storage: window.localStorage });

  function atBottom() {
    if (!bodyEl) return true;
    return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
  }
  function scrollToBottom() {
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ── data loading + live updates ──
  function loadTranscript() {
    if (!sessionId) {
      entries = [];
      return Promise.resolve();
    }
    return doFetch('/api/session?id=' + encodeURIComponent(sessionId))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        entries = data.entries || [];
        if (pendingUser) {
          const arrived = entries.some(
            (e) =>
              e &&
              e.type === 'message' &&
              e.message &&
              e.message.role === 'user' &&
              btwContentText(e.message.content).trim() === pendingUser,
          );
          if (arrived) pendingUser = null;
        }
      })
      .catch(() => {});
  }

  function subscribe() {
    unsubscribe();
    eventSource = setupBtwSessionEvents({
      sessionId,
      EventSourceImpl: window.EventSource,
      onReload: () => {
        streamingText = '';
        loadTranscript();
        refreshStatus();
      },
      onChatPreview: (payload) => {
        streamingText = payload.content || '';
        if (!payload.done) setRunning(true);
      },
    });
  }
  function unsubscribe() {
    closeBtwEventSource(eventSource);
    eventSource = null;
  }
  function subscribeGlobal() {
    if (globalSource) return;
    globalSource = setupBtwParentEvents({
      parentTopic: parentTopic(),
      EventSourceImpl: window.EventSource,
      onChanged: (id) => {
        if (id !== sessionId) setSession(id);
      },
    });
  }
  function unsubscribeGlobal() {
    closeBtwEventSource(globalSource);
    globalSource = null;
  }

  // ── worker running state (spinner + cancel button) ──
  function startSpinner() {
    if (spinnerTimer) return;
    spinnerConfig = getSpinnerConfig(window);
    spinnerStyle = `font-family:${spinnerConfig.fontFamily};width:${spinnerConfig.width}`;
    spinnerChar = spinnerConfig.frames[spinnerFrame % spinnerConfig.frames.length] || '';
    spinnerTimer = window.setInterval(() => {
      spinnerFrame += 1;
      spinnerChar = spinnerConfig.frames[spinnerFrame % spinnerConfig.frames.length] || '';
    }, spinnerConfig.interval || 100);
  }
  function stopSpinner() {
    if (spinnerTimer) {
      window.clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }
  function setRunning(on) {
    running = !!on;
    if (running) startSpinner();
    else {
      stopSpinner();
      streamingText = '';
    }
  }

  function refreshStatus() {
    if (!sessionId) return Promise.resolve();
    return doFetch('/api/worker-status?id=' + encodeURIComponent(sessionId))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        if (data.state === 'running') setRunning(true);
        else if (data.state === 'idle') {
          if (Date.now() - lastSentAt > IDLE_GRACE_MS) setRunning(false);
        } else if (data.state === 'error') setRunning(false);
      })
      .catch(() => {});
  }
  function startStatusPolling() {
    if (statusTimer) return;
    statusTimer = window.setInterval(() => refreshStatus(), STATUS_POLL_MS);
  }
  function stopStatusPolling() {
    if (statusTimer) {
      window.clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  function cancel() {
    if (!sessionId) return;
    doFetch('/api/chat/cancel?id=' + encodeURIComponent(sessionId), { method: 'POST' })
      .then(() => setRunning(false))
      .catch(() => {});
  }

  // ── actions ──
  function setSession(id) {
    sessionId = id || '';
    entries = [];
    pendingUser = null;
    streamingText = '';
    setRunning(false);
    if (sessionId) {
      subscribe();
      loadTranscript();
      refreshStatus();
    } else {
      unsubscribe();
    }
  }
  function createSession() {
    return doFetch('/api/btw/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: cwd, parent: parentId }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.id) {
          setSession(data.id);
          return data.id;
        }
        throw new Error(data && data.error ? data.error : 'failed to create btw session');
      });
  }
  // Lazy "new": clear to the empty state without creating a session file.
  function startNewSession() {
    setSession('');
    inputEl?.focus();
  }
  async function submitMessage() {
    const message = inputEl ? inputEl.value.trim() : '';
    if (!message) return;
    inputEl.value = '';
    pendingUser = message;
    lastSentAt = Date.now();
    try {
      if (!sessionId) await createSession();
      // createSession() runs setSession() which clears optimistic state; re-show.
      pendingUser = message;
      setRunning(true);
      const body = new window.FormData();
      body.set('message', message);
      const resp = await doFetch('/api/chat?id=' + encodeURIComponent(sessionId), {
        method: 'POST',
        body,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'chat request failed');
    } catch {
      pendingUser = null;
      setRunning(false);
      if (inputEl) inputEl.value = message;
    }
  }

  // ── open / close ──
  function openWindow() {
    open = true;
    // Clear `hidden` synchronously (Svelte's flush from `open` is async) so the
    // window has real dimensions when initial placement measures it.
    if (winEl) winEl.hidden = false;
    const geom = loadGeom();
    if (winEl && geom && geom.width) winEl.style.width = `${geom.width}px`;
    if (winEl && geom && geom.height) winEl.style.height = `${geom.height}px`;
    if (winEl)
      placeBtwInitial(winEl, {
        windowImpl: window,
        loadGeometry: loadGeom,
        saveGeometry: saveGeom,
      });
    btnEl?.setAttribute('aria-expanded', 'true');
    saveGeom({ open: true });
    subscribeGlobal();
    startStatusPolling();
    doFetch('/api/btw?parent=' + encodeURIComponent(parentTopic()))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const id = data && data.sessionId ? data.sessionId : '';
        if (id !== sessionId) setSession(id);
        else if (id) {
          loadTranscript();
          refreshStatus();
        }
      })
      .catch(() => {});
    inputEl?.focus();
  }
  function closeWindow() {
    open = false;
    btnEl?.setAttribute('aria-expanded', 'false');
    saveGeom({ open: false });
    unsubscribe();
    unsubscribeGlobal();
    stopStatusPolling();
    stopSpinner();
  }
  function toggle() {
    if (open) closeWindow();
    else openWindow();
  }

  function onSubmit(e) {
    e.preventDefault();
    submitMessage();
  }
  function onSend() {
    if (running) cancel();
    else submitMessage();
  }

  // Changes whenever the visible transcript does, so the auto-scroll effect can
  // depend on one value instead of listing each piece of state separately.
  const transcriptSignature = $derived(
    [renderedEntries.length, pendingUser ?? '', streamingText, running, open].join('|'),
  );

  // Auto-scroll to bottom when the transcript changes if the user was near it.
  $effect(() => {
    void transcriptSignature;
    if (open && nearBottom) scrollToBottom();
  });

  onMount(() => {
    if (winEl) document.body.appendChild(winEl);
    if (winEl && headerEl) {
      enableBtwDrag(winEl, headerEl, {
        documentImpl: document,
        windowImpl: window,
        saveGeometry: saveGeom,
      });
      persistBtwResize(winEl, { windowImpl: window, saveGeometry: saveGeom });
    }
    const onBodyScroll = () => {
      nearBottom = atBottom();
    };
    bodyEl?.addEventListener('scroll', onBodyScroll);

    btnEl = document.getElementById('pi-btw-button');
    const onBtnClick = (e) => {
      e.preventDefault();
      toggle();
    };
    if (btnEl) {
      btnEl.setAttribute('aria-haspopup', 'dialog');
      btnEl.setAttribute('aria-expanded', 'false');
      btnEl.addEventListener('click', onBtnClick);
    }

    const composerTextarea = document.getElementById('pi-chat-message');
    const onComposerFocus = () => {
      if (isMobile() && open) closeWindow();
    };
    composerTextarea?.addEventListener('focus', onComposerFocus);

    // Auto-reopen if it was open before a reload — but not on mobile.
    const initialGeom = loadGeom();
    if (initialGeom && initialGeom.open && !isMobile()) openWindow();

    return () => {
      unsubscribe();
      unsubscribeGlobal();
      stopStatusPolling();
      stopSpinner();
      btnEl?.removeEventListener('click', onBtnClick);
      composerTextarea?.removeEventListener('focus', onComposerFocus);
      bodyEl?.removeEventListener('scroll', onBodyScroll);
      // eslint-disable-next-line svelte/no-dom-manipulating -- imperatively-created popup window, not a Svelte-rendered node
      winEl?.remove();
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div class="pi-btw-window" role="dialog" aria-label="btw" bind:this={winEl} hidden={!open}>
  <div class="pi-btw-header" bind:this={headerEl}>
    <span class="pi-btw-title">btw</span>
    <div class="pi-btw-actions">
      <button type="button" class="pi-btw-new" title={t('btw.newChat')} onclick={startNewSession}
        >{t('btw.new')}</button
      >
      <button
        type="button"
        class="pi-btw-close"
        aria-label={t('common.close')}
        onclick={closeWindow}>{@html icon(X, { size: 16 })}</button
      >
    </div>
  </div>
  <div class="pi-btw-body" id="pi-btw-body" bind:this={bodyEl}>
    {#if isEmpty}
      <div class="pi-btw-empty">
        {sessionId ? t('btw.emptyHasSession') : t('btw.emptyNoSession')}
      </div>
    {:else}
      {#each renderedEntries as r, rIndex (rIndex)}
        <div class="pi-btw-msg {r.role}">
          {#each r.parts as p, pIndex (pIndex)}
            {#if p.kind === 'md'}<div class="pi-btw-md">{@html p.html}</div>{:else}<div
                class="pi-btw-tool"
              >
                {p.text}
              </div>{/if}
          {/each}
        </div>
      {/each}
      {#if pendingUser}<div class="pi-btw-msg user pending">
          <div class="pi-btw-md">{@html toHtml(pendingUser)}</div>
        </div>{/if}
      {#if running || streamingText}
        <div class="pi-btw-msg assistant working">
          {#if streamingText}<div class="pi-btw-md">{@html toHtml(streamingText)}</div>{:else}<span
              class="pi-btw-working"
              ><span class="pi-btw-spinner" style={spinnerStyle}>{spinnerChar}</span><span
                class="pi-btw-working-label">{t('btw.working')}</span
              ></span
            >{/if}
        </div>
      {/if}
    {/if}
  </div>
  <form class="pi-btw-input-row" id="pi-btw-form" onsubmit={onSubmit}>
    <input
      type="text"
      class="pi-btw-input"
      id="pi-btw-input"
      placeholder={t('btw.inputPlaceholder')}
      autocomplete="off"
      bind:this={inputEl}
    />
    <button
      type="button"
      class="pi-btw-send"
      id="pi-btw-send"
      class:cancel={running}
      aria-label={running ? t('composer.cancel') : t('composer.send')}
      title={running ? t('btw.stop') : t('composer.send')}
      onclick={onSend}
      >{@html running ? icon(Square, { size: 16 }) : icon(Send, { size: 16 })}</button
    >
  </form>
</div>
