<script lang="ts">
  // Live reload (SSE) — drives the streaming chat preview, follow/scroll, stats,
  // and reconciles the shared reactive model when the session JSONL changes. The
  // Svelte <SessionContent> owns #messages and re-renders from the model, so this
  // never patches the message DOM (reactive-only): on reload it reconciles the
  // model through the session runtime context and only tracks brand-new ids for the
  // follow/scroll/highlight decisions. Live-only: never imported by the static
  // export bundle.
  //
  // The old live-reload runner has been split between this component and focused
  // live-only helpers in session/live/: connection/reconnect lifecycle, reload
  // events, follow-scroll, stats, and chat-preview all have focused unit tests.
  import { onMount, tick } from 'svelte';
  import { marked } from 'marked';
  import { Effect, Option, Schema } from 'effect';
  import { escapeHtml } from '../../session/render/session-format.js';
  import {
    clearChatPreviewState,
    finishChatPreviewState,
    renderChatPreviewState,
    renderPendingChatState,
  } from '../../session/live/chat-preview.js';
  import {
    getReloadEntryCount,
    getSessionIdFromLocation,
    handleSessionReload,
    projectionContainsPreview,
    shouldReplaceProjectionEntries,
  } from '../../session/live/live-events.js';
  import {
    setupSessionLiveConnection,
    type SessionConnectionState,
  } from '../../session/live/live-connection.js';
  import {
    createFollowScrollController,
    type FollowScrollState,
  } from '../../session/live/live-follow.js';
  import { updateStatsDom } from '../../session/live/live-stats.js';
  import { getSessionRuntime } from '../../session/session-runtime-context.js';
  import { setSessionTitle } from '../../session/session-title.svelte.js';
  import { SessionDataModel } from '../../session/data/session-data.svelte.js';
  import type { SessionEntry } from '../../session/data/session-types.js';
  import type { ChatPreviewState } from '../../session/live/chat-preview.js';
  import { NetworkError } from '../../lib/errors.js';
  import { runPromise, runSync } from '../../lib/runtime.js';

  const ChatSentDetailSchema = Schema.Struct({ message: Schema.optional(Schema.Unknown) });
  const decodeChatSentDetail = Schema.decodeUnknownOption(ChatSentDetailSchema);

  let {
    initialState,
    onStateCapture = () => {},
    onConnectionState = () => {},
  }: {
    readonly initialState?: FollowScrollState;
    readonly onStateCapture?: (state: FollowScrollState) => void;
    readonly onConnectionState?: (state: SessionConnectionState) => void;
  } = $props();

  onMount(() => {
    const documentImpl = document;
    const windowImpl = window;
    const runtime = getSessionRuntime();
    const model = runtime.model instanceof SessionDataModel ? runtime.model : null;
    const reconcileEntries = (
      entries: ReadonlyArray<SessionEntry>,
      options: { readonly isDelta: boolean; readonly replaceExisting: boolean },
    ): unknown => runtime.reconcileEntries?.(entries, options);
    const testHook: unknown = Object.getOwnPropertyDescriptor(
      globalThis,
      '__PI_TEST_LIVE_RELOAD_HOOK__',
    )?.value;
    if (typeof testHook === 'function') testHook();

    const fetchImpl = windowImpl.fetch.bind(windowImpl);
    const requestAnimationFrame = windowImpl.requestAnimationFrame.bind(windowImpl);
    const setTimeout = windowImpl.setTimeout.bind(windowImpl);

    const cleanups: Array<() => void> = [];
    const on = (
      host: EventTarget,
      type: string,
      handler: EventListener,
      opts?: boolean | AddEventListenerOptions,
    ): void => {
      host.addEventListener(type, handler, opts);
      cleanups.push(() => host.removeEventListener(type, handler, opts));
    };

    // Markdown for the streaming preview — globally-configured (sanitized) marked
    // with an escapeHtml fallback (matches the former live-renderer.renderMarkdown).
    const renderMarkdown = (text: string): string =>
      runSync(
        Effect.try({
          try: () => marked.parse(text, { async: false }),
          catch: () => escapeHtml(text, { documentImpl }),
        }).pipe(Effect.catch((fallback) => Effect.succeed(fallback))),
      );

    // New-entry highlight (after Svelte renders the reactive path).
    function highlightNewEntry(node: HTMLElement): void {
      node.classList.add('new-entry-highlight');
      setTimeout(() => {
        node.classList.remove('new-entry-highlight');
      }, 1500);
    }
    function highlightNewEntries(newIds: string[]): void {
      requestAnimationFrame(() => {
        newIds.forEach((id) => {
          const el = documentImpl.getElementById('entry-' + id);
          if (el) highlightNewEntry(el);
        });
      });
    }

    // "seen" set seeded from the model (the DOM may not be flushed yet at startup).
    const LIVE_ENTRY_STATE = {
      seen: new Set<string>((model?.entries || []).map((entry) => entry.id)),
      liveRendered: new Set<string>(),
    };

    // ── Follow mode (auto-scroll + follow-button decisions) ────────────────────
    // The controller registers its own scroll/wheel/touch/keydown listeners and
    // performs the initial scroll-to-bottom; we just dispose it on unmount.
    const followScroll = createFollowScrollController({
      documentImpl,
      requestAnimationFrameImpl: requestAnimationFrame,
      setTimeoutImpl: setTimeout,
      initialState,
      onStateCapture,
    });
    cleanups.push(followScroll.dispose);
    const {
      shouldFollow,
      forceFollowToBottom,
      scrollAfterLayout,
      showFollowButton,
      incrementPending,
      isFollowing,
      isAtBottom,
    } = followScroll;

    on(windowImpl, 'pi-chat-message-sent', (event: Event) => {
      followScroll.extendPreviewFollow(30000);
      const detail: { readonly message?: unknown } =
        event instanceof CustomEvent
          ? Option.getOrElse(decodeChatSentDetail(event.detail), () => ({}))
          : {};
      if (detail.message) {
        renderPendingChat(detail.message);
      } else {
        forceFollowToBottom(true);
      }
    });

    function updateStats(entries: SessionEntry[]): boolean {
      return updateStatsDom(entries, { documentImpl });
    }
    function updateTitle(name: string): void {
      setSessionTitle(name);
    }

    const sessId = getSessionIdFromLocation({ locationImpl: windowImpl.location });

    // ── Streaming chat preview ─────────────────────────────────────────────────
    const CHAT_PREVIEW_STATE: ChatPreviewState = { chatPreviewEl: null, pendingUserEl: null };

    function clearChatPreview(entries: ReadonlyArray<SessionEntry> = []): void {
      const statusEl = documentImpl.getElementById('pi-chat-status');
      const isChatRunning = statusEl && statusEl.classList.contains('running');
      const hasDoneClass =
        CHAT_PREVIEW_STATE.chatPreviewEl &&
        CHAT_PREVIEW_STATE.chatPreviewEl.classList.contains('done');
      const authoritativeClaudeMessage = projectionContainsPreview(
        entries,
        CHAT_PREVIEW_STATE.previewItemId,
      );
      const keepAssistant = !!(isChatRunning && !hasDoneClass && !authoritativeClaudeMessage);
      return clearChatPreviewState(CHAT_PREVIEW_STATE, { keepAssistant });
    }
    function finishChatPreview(): void {
      finishChatPreviewState(CHAT_PREVIEW_STATE);
    }
    function renderChatPreview(payload: unknown): void {
      renderChatPreviewState(payload, CHAT_PREVIEW_STATE, {
        documentImpl,
        windowImpl,
        renderMarkdown,
        shouldFollow,
        forceFollowToBottom,
        scrollAfterLayout,
      });
    }
    function renderPendingChat(message: unknown): boolean {
      return renderPendingChatState(message, CHAT_PREVIEW_STATE, {
        documentImpl,
        windowImpl,
        renderMarkdown,
        shouldFollow,
        forceFollowToBottom,
        scrollAfterLayout,
      });
    }

    // ── Reload (fetch /api/session → reconcile the model) ──────────────────────
    // A live getter (not a snapshotted count) into the model's canonical entry
    // count: reading it fresh on every reload keeps the delta request correct
    // even if something else (e.g. LoadEarlier prepending older entries)
    // changed model.entries between reloads. Returns null when the model is
    // tail-windowed/paginated (model.truncated) — model.entries.length isn't a
    // from-0 prefix count in that case, so the delta request is disabled and a
    // full reconcile is used instead.
    const getEntryCount = () => getReloadEntryCount(model);
    let reloadGeneration = 0;

    function triggerReload(
      _event?: unknown,
      connectionShouldApply: () => boolean = () => true,
    ): Promise<boolean> {
      const generation = ++reloadGeneration;
      const shouldApply = () => generation === reloadGeneration && connectionShouldApply();
      return runPromise(
        Effect.tryPromise({
          try: () =>
            handleSessionReload({
              sessionId: sessId,
              fetchImpl,
              entryState: LIVE_ENTRY_STATE,
              clearChatPreview,
              // Reactive mode: the Svelte model owns #messages, so no DOM patchers.
              updateStats,
              updateTitle,
              isFollowing,
              isAtBottom,
              scrollAfterLayout,
              incrementPending,
              showFollowButton,
              getEntryCount,
              shouldApply,
              onReloaded: async (data) => {
                reconcileEntries(data.entries, {
                  isDelta: data.isDelta,
                  replaceExisting: shouldReplaceProjectionEntries(data.projectionMode),
                });
                await tick();
              },
              onNewEntries: highlightNewEntries,
            }),
          catch: (cause) => new NetworkError({ cause }),
        }).pipe(
          Effect.map((result) => result.stale !== true),
          Effect.catch((error) =>
            Effect.sync(() => {
              console.error('Live update failed:', error);
              return false;
            }),
          ),
        ),
      );
    }

    let recoverAuthoritatively = (): Promise<boolean> => triggerReload();

    on(windowImpl, 'pi-worker-done', () => {
      // If the final filesystem reload is missed/delayed, don't leave the
      // streaming preview "working"; proactively reconcile from /api/session.
      finishChatPreview();
      void recoverAuthoritatively();
    });

    on(windowImpl, 'pi-chat-cancel-accepted', () => {
      // Native acknowledgement means Stop was received, not that the worker is
      // idle. The optimistic transcript is no longer trustworthy, though, so
      // clear it immediately and reconcile any persisted partial/final output.
      clearChatPreviewState(CHAT_PREVIEW_STATE);
      void recoverAuthoritatively();
    });

    on(windowImpl, 'pi-worker-status', (event: Event) => {
      if (!(event instanceof CustomEvent) || !model) return;
      const detail = event.detail;
      if (typeof detail !== 'object' || detail === null || typeof detail.state !== 'string') return;
      model.setWorkerStatus({
        state: detail.state,
        error: typeof detail.error === 'string' ? detail.error : undefined,
        exitCode: typeof detail.exitCode === 'number' ? detail.exitCode : undefined,
      });
    });

    const liveConnection = setupSessionLiveConnection({
      documentImpl,
      sessionId: sessId,
      onReload: triggerReload,
      onChatPreview: renderChatPreview,
      onWorkerStatus: (status) => model?.setWorkerStatus(status),
      onStateChange: onConnectionState,
    });
    recoverAuthoritatively = liveConnection.recover;
    liveConnection.connect();
    cleanups.push(liveConnection.dispose);

    return () => {
      for (const fn of cleanups) fn();
    };
  });
</script>
