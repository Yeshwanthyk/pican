<script lang="ts">
  import { onMount, tick } from 'svelte';
  import SessionShell from '../components/session/SessionShell.svelte';
  import { applyLazyHighlighting } from '../session/lazy-highlight';
  import { loadSessionPageState } from './session-page-data';
  import { SessionDataModel } from '../session/data/session-data.svelte';
  import { isUnknownRecord } from '../session/data/session-types';
  import {
    hydrateSessionModel,
    createLiveSessionRuntime,
  } from '../session/page/session-page-model';
  import {
    applySessionPageBodyClasses,
    applyStoredSessionLayout,
  } from '../session/page/session-page-layout';
  import { startSessionPageRuntime } from '../session/page/session-page-runtime';
  import { setSessionModel } from '../session/session-context';
  import { resetSessionModals } from '../session/session-modals.svelte';
  import { resetSessionRuntime } from '../session/session-runtime';
  import { resetSessionRuntimeContext } from '../session/session-runtime-context';
  import { t } from '../shared/strings';
  import { errorMessage, settle } from '../components/shared/ui-effect';

  // The reactive session model (docs/dev/svelte-migration-plan.md): created once
  // and provided via context so descendant components read from it. Hydrated
  // from the session payload below; the live runtime (startSessionPageRuntime in
  // onMount) mutates it on reload.
  // oxlint-disable-next-line typescript/no-unsafe-declaration-merging -- compatibility shim for the session partition's string-indexed runtime contract
  interface RouteSessionDataModel {
    [key: string]: unknown;
  }

  class RouteSessionDataModel extends SessionDataModel {
    override load(data: unknown): void {
      if (isUnknownRecord(data)) super.load(data);
    }

    override reconcile(entries: ReadonlyArray<unknown> = [], options?: unknown): void {
      const normalized = entries.filter(isUnknownRecord);
      const record = isUnknownRecord(options) ? options : {};
      super.reconcile(normalized, {
        isDelta: record.isDelta === true,
        replaceExisting: record.replaceExisting === true,
      });
    }
  }

  const sessionModel = setSessionModel(new RouteSessionDataModel());

  // Post-render hook for the message pane: <SessionContent> renders
  // model.activePath as <SessionEntry> components and runs afterRender after each
  // render. wireSessionContentRuntime() (in onMount) assigns it (toggle state +
  // lazy highlight); the $state proxy makes the hook apply reactively.
  const contentRuntime = $state<{ afterRender: ((container: HTMLElement) => void) | null }>({
    afterRender: null,
  });

  let loading = $state(true);
  let showLoading = $state(false);
  let error = $state('');
  let sessionId = $state('');
  let title = $state('Session');
  let payloadBase64 = $state('');
  let scratchpad = $state('');
  let cwd = $state('');
  let chatAvailable = $state(true);
  let chatDisabledReason = $state('');
  let modelLabel = $state('');
  let runtime = $state('pi');
  let nativeId = $state('');
  let sessionUUID = $state('');
  let dataEl = $state<HTMLScriptElement | null>(null);

  onMount(() => {
    const previousTitle = document.title;
    const previousRuntime = document.body?.dataset.runtime;
    const previousNativeId = document.body?.dataset.nativeId;
    let active = true;
    let disposeRuntime: (() => void) | null = null;
    const disposeBodyClasses = applySessionPageBodyClasses({ documentImpl: document });
    applyStoredSessionLayout({
      documentImpl: document,
      windowImpl: window,
      storage: window.localStorage,
    });

    // Avoid flashing the loading text on fast (localhost) loads: only reveal the
    // indicator if the fetch is still pending after a short delay.
    const loadingTimer = setTimeout(() => {
      if (active && loading) showLoading = true;
    }, 200);

    void (async () => {
      const result = await settle(() =>
        loadSessionPageState({
          locationSearch: window.location.search,
          fetchImpl: window.fetch.bind(window),
        }),
      );
      if (result.ok) {
        const state = result.value;
        if (!active) return;
        sessionId = state.sessionId;
        title = state.title;
        runtime = state.runtime;
        nativeId = state.nativeId;
        sessionUUID = state.sessionUUID;
        document.title =
          runtime === 'codex'
            ? t('session.runtimePageTitle', { title, runtime: t('runtime.codex') })
            : title;
        if (document.body) {
          document.body.dataset.runtime = runtime;
          if (nativeId) document.body.dataset.nativeId = nativeId;
          else delete document.body.dataset.nativeId;
        }
        cwd = state.cwd;
        scratchpad = state.scratchpad;
        payloadBase64 = state.payloadBase64;
        chatAvailable = state.chatAvailable;
        chatDisabledReason = state.chatDisabledReason;
        modelLabel = state.modelLabel;
        hydrateSessionModel({
          sessionModel,
          payloadBase64,
          locationSearch: window.location.search,
          windowImpl: window,
        });
        createLiveSessionRuntime({ sessionModel, contentRuntime, documentImpl: document });
        loading = false;
        clearTimeout(loadingTimer);
        await tick();
        if (!active) return;
        // Svelte does not interpolate mustache tags inside a <script lang="ts"> raw-text
        // element, so the embedded session payload must be assigned directly.
        if (dataEl) dataEl.textContent = payloadBase64;
        disposeRuntime = startSessionPageRuntime({
          sessionId,
          applyLazyHighlighting,
          windowImpl: window,
          documentImpl: document,
        });
        applyLazyHighlighting(document);
      } else {
        if (!active) return;
        error = errorMessage(result.error, 'Failed to load session');
        loading = false;
        clearTimeout(loadingTimer);
      }
    })();

    return () => {
      active = false;
      clearTimeout(loadingTimer);
      disposeRuntime?.();
      resetSessionModals();
      resetSessionRuntime();
      resetSessionRuntimeContext();
      document.title = previousTitle;
      if (document.body) {
        if (previousRuntime === undefined) delete document.body.dataset.runtime;
        else document.body.dataset.runtime = previousRuntime;
        if (previousNativeId === undefined) delete document.body.dataset.nativeId;
        else document.body.dataset.nativeId = previousNativeId;
      }
      disposeBodyClasses();
    };
  });
</script>

{#if loading}
  {#if showLoading}
    <div class="session-loading" role="status" aria-live="polite">
      <span class="session-loading-spinner" aria-hidden="true"></span>
      <span class="session-loading-text">{t('session.loading')}</span>
    </div>
  {/if}
{:else if error}
  <div class="session-loading session-loading--error">
    <h1>{error}</h1>
    <p><a href="/">{t('session.backToSessions')}</a></p>
  </div>
{:else}
  <SessionShell
    {sessionModel}
    {contentRuntime}
    {sessionId}
    {title}
    {scratchpad}
    {cwd}
    {chatAvailable}
    {chatDisabledReason}
    {modelLabel}
    {runtime}
    {nativeId}
    {sessionUUID}
    bind:dataEl
  />
{/if}
