<script lang="ts">
  // The "btw" floating, draggable, resizable scratch-chat opened from the git
  // bar (#pi-btw-button, in <ChatComposer>). Its own per-parent btw session is
  // persisted server-side and synced over SSE. The transcript renders reactively;
  // drag/resize/SSE/status-polling/submit stay imperative. Live-only — never in
  // the export bundle. See docs/sequence-flows/btw.md.
  import { Effect, Schema } from 'effect';
  import { onMount } from 'svelte';
  import * as Http from '../../lib/http.js';
  import { runPromise } from '../../lib/runtime.js';
  import { sessionEntryFromUnknown, type SessionEntry } from '../../session/data/session-types.js';
  import { sendChat as sendChatApi } from '../../session/chat/chat-api.js';
  import { getSpinnerConfig } from '../../session/live/chat-preview.js';
  import { t } from '../../shared/strings.js';
  import { icon, X, Square, Send } from '../../shared/icons.js';
  import {
    enableBtwDrag,
    loadBtwGeometry,
    persistBtwResize,
    placeBtwInitial,
    saveBtwGeometry,
  } from './btw-geometry.js';
  import type { BtwGeometry } from './btw-geometry.js';
  import {
    closeBtwEventSource,
    setupBtwParentEvents,
    setupBtwSessionEvents,
  } from './btw-events.js';
  import { btwContentText, createBtwMarkdownRenderer, renderBtwEntryParts } from './btw-render.js';

  let { cwd = '', parentId = '' }: { cwd?: string; parentId?: string } = $props();

  const TranscriptResponse = Schema.Struct({
    entries: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  });
  const WorkerStatusResponse = Schema.Struct({ state: Schema.optionalKey(Schema.String) });
  const BtwSessionResponse = Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) });
  const BtwNewResponse = Schema.Struct({ id: Schema.String });
  const ChatResponse = Schema.Struct({ error: Schema.optionalKey(Schema.String) });
  const decodeChatResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatResponse));

  const GLOBAL_PARENT = '__global__';
  // After a send, ignore an "idle" status for this long so the spinner doesn't
  // flicker off before the worker has actually started.
  const IDLE_GRACE_MS = 3000;
  const STATUS_POLL_MS = 1500;

  let open = $state(false);
  let entries = $state<SessionEntry[]>([]);
  let pendingUser = $state<string | null>(null);
  let streamingText = $state('');
  let running = $state(false);
  let sessionId = $state('');
  let spinnerChar = $state('');
  let spinnerStyle = $state('');

  let winEl = $state<HTMLDivElement | null>(null);
  let headerEl = $state<HTMLDivElement | null>(null);
  let bodyEl = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  // Non-reactive runtime handles.
  let btnEl: HTMLElement | null = null;
  let eventSource: EventSource | null = null;
  let globalSource: EventSource | null = null;
  let statusTimer: number | null = null;
  let spinnerTimer: number | null = null;
  let spinnerFrame = 0;
  let spinnerConfig: ReturnType<typeof getSpinnerConfig> | null = null;
  let lastSentAt = 0;
  let nearBottom = true;

  const parentTopic = (): string => parentId || GLOBAL_PARENT;
  const isMobile = (): boolean =>
    !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  const toHtml = createBtwMarkdownRenderer({ documentImpl: document });
  const renderEntryParts = (entry: SessionEntry) => renderBtwEntryParts(entry, { toHtml });

  const renderedEntries = $derived(
    entries
      .map(renderEntryParts)
      .filter((entry): entry is NonNullable<ReturnType<typeof renderEntryParts>> => entry !== null),
  );
  const isEmpty = $derived(
    renderedEntries.length === 0 && !pendingUser && !(running || streamingText),
  );

  const loadGeom = (): BtwGeometry | null => loadBtwGeometry({ storage: window.localStorage });
  const saveGeom = (patch: BtwGeometry): void =>
    saveBtwGeometry(patch, { storage: window.localStorage });

  function atBottom(): boolean {
    if (!bodyEl) return true;
    return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
  }
  function scrollToBottom(): void {
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  // ── data loading + live updates ──
  function loadTranscript(): Promise<void> {
    if (!sessionId) {
      entries = [];
      return Promise.resolve();
    }
    return runPromise(
      Http.get('/api/session?id=' + encodeURIComponent(sessionId), TranscriptResponse),
    ).then(
      (data) => {
        entries = (data.entries ?? []).flatMap((entry) => {
          const parsed = sessionEntryFromUnknown(entry);
          return parsed ? [parsed] : [];
        });
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
      },
      () => undefined,
    );
  }

  function subscribe(): void {
    unsubscribe();
    eventSource = setupBtwSessionEvents({
      sessionId,
      EventSourceImpl: window.EventSource,
      onReload: () => {
        streamingText = '';
        void loadTranscript();
        void refreshStatus();
      },
      onChatPreview: (payload) => {
        streamingText = payload.content || '';
        if (!payload.done) setRunning(true);
      },
    });
  }
  function unsubscribe(): void {
    closeBtwEventSource(eventSource);
    eventSource = null;
  }
  function subscribeGlobal(): void {
    if (globalSource) return;
    globalSource = setupBtwParentEvents({
      parentTopic: parentTopic(),
      EventSourceImpl: window.EventSource,
      onChanged: (id) => {
        if (id !== sessionId) setSession(id);
      },
    });
  }
  function unsubscribeGlobal(): void {
    closeBtwEventSource(globalSource);
    globalSource = null;
  }

  // ── worker running state (spinner + cancel button) ──
  function startSpinner(): void {
    if (spinnerTimer) return;
    spinnerConfig = getSpinnerConfig(window);
    const config = spinnerConfig;
    spinnerStyle = `font-family:${config.fontFamily};width:${config.width}`;
    spinnerChar = config.frames[spinnerFrame % config.frames.length] || '';
    spinnerTimer = window.setInterval(() => {
      spinnerFrame += 1;
      spinnerChar = config.frames[spinnerFrame % config.frames.length] || '';
    }, config.interval || 100);
  }
  function stopSpinner(): void {
    if (spinnerTimer) {
      window.clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  }
  function setRunning(on: boolean): void {
    running = !!on;
    if (running) startSpinner();
    else {
      stopSpinner();
      streamingText = '';
    }
  }

  function refreshStatus(): Promise<void> {
    if (!sessionId) return Promise.resolve();
    return runPromise(
      Http.get('/api/worker-status?id=' + encodeURIComponent(sessionId), WorkerStatusResponse),
    ).then(
      (data) => {
        if (data.state === 'running') setRunning(true);
        else if (data.state === 'idle') {
          if (Date.now() - lastSentAt > IDLE_GRACE_MS) setRunning(false);
        } else if (data.state === 'error') setRunning(false);
      },
      () => undefined,
    );
  }
  function startStatusPolling(): void {
    if (statusTimer) return;
    statusTimer = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS);
  }
  function stopStatusPolling(): void {
    if (statusTimer) {
      window.clearInterval(statusTimer);
      statusTimer = null;
    }
  }

  function cancel(): void {
    if (!sessionId) return;
    void runPromise(
      Http.post('/api/chat/cancel?id=' + encodeURIComponent(sessionId), undefined, Schema.Unknown),
    ).then(
      () => setRunning(false),
      () => undefined,
    );
  }

  // ── actions ──
  function setSession(id: string): void {
    sessionId = id || '';
    entries = [];
    pendingUser = null;
    streamingText = '';
    setRunning(false);
    if (sessionId) {
      subscribe();
      void loadTranscript();
      void refreshStatus();
    } else {
      unsubscribe();
    }
  }
  function createSession(): Promise<string> {
    return runPromise(
      Http.post('/api/btw/new', { path: cwd, parent: parentId }, BtwNewResponse),
    ).then((data) => {
      setSession(data.id);
      return data.id;
    });
  }
  // Lazy "new": clear to the empty state without creating a session file.
  function startNewSession(): void {
    setSession('');
    inputEl?.focus();
  }
  function sendChatRequest(message: string, targetSessionId: string) {
    return Effect.gen(function* () {
      const body = new FormData();
      body.set('message', message);
      const response = yield* Effect.tryPromise({
        try: () => sendChatApi(targetSessionId, body),
        catch: (cause) => cause,
      });
      const responseText = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => cause,
      });
      const data = yield* decodeChatResponse(responseText);
      if (!response.ok) {
        return yield* Effect.fail(new Error(data.error ?? 'chat request failed'));
      }
    });
  }

  function submitMessage(): void {
    const input = inputEl;
    if (!input) return;
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    pendingUser = message;
    lastSentAt = Date.now();
    const restore = (): void => {
      pendingUser = null;
      setRunning(false);
      if (inputEl) inputEl.value = message;
    };
    const sessionReady = sessionId ? Promise.resolve(sessionId) : createSession();
    void sessionReady.then((targetSessionId) => {
      // createSession() runs setSession() which clears optimistic state; re-show.
      pendingUser = message;
      setRunning(true);
      void runPromise(sendChatRequest(message, targetSessionId)).then(() => undefined, restore);
    }, restore);
  }

  // ── open / close ──
  function openWindow(): void {
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
    void runPromise(
      Http.get('/api/btw?parent=' + encodeURIComponent(parentTopic()), BtwSessionResponse),
    ).then(
      (data) => {
        const id = data.sessionId ?? '';
        if (id !== sessionId) setSession(id);
        else if (id) {
          void loadTranscript();
          void refreshStatus();
        }
      },
      () => undefined,
    );
    inputEl?.focus();
  }
  function closeWindow(): void {
    open = false;
    btnEl?.setAttribute('aria-expanded', 'false');
    saveGeom({ open: false });
    unsubscribe();
    unsubscribeGlobal();
    stopStatusPolling();
    stopSpinner();
  }
  function toggle(): void {
    if (open) closeWindow();
    else openWindow();
  }

  function onSubmit(e: SubmitEvent): void {
    e.preventDefault();
    submitMessage();
  }
  function onSend(): void {
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
    const onBodyScroll = (): void => {
      nearBottom = atBottom();
    };
    bodyEl?.addEventListener('scroll', onBodyScroll);

    btnEl = document.getElementById('pi-btw-button');
    const onBtnClick = (e: MouseEvent): void => {
      e.preventDefault();
      toggle();
    };
    if (btnEl) {
      btnEl.setAttribute('aria-haspopup', 'dialog');
      btnEl.setAttribute('aria-expanded', 'false');
      btnEl.addEventListener('click', onBtnClick);
    }

    const composerTextarea = document.getElementById('pi-chat-message');
    const onComposerFocus = (): void => {
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
