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
  import { boolFor } from '../settings/settings-support';
  import { SESSION_TABS_SETTING_KEY } from '../shared/settings-store';
  import { errorMessage, settle } from '../components/shared/ui-effect';
  import { withBasePath } from '../shared/base-path';
  import { parentSessionParam } from '../subagents/subagents';
  import type {
    SessionSwitchUiState,
    SessionSwitchUiStatePatch,
  } from '../session/session-switch-state';
  import {
    defaultRuntimeCapabilities,
    type CompleteRuntimeCapabilities,
  } from '../lib/runtime-capabilities';

  // The reactive session model (docs/dev/svelte-migration-plan.md): created once
  // and provided via context so descendant components read from it. Hydrated
  // from the session payload below; the live runtime (startSessionPageRuntime in
  // onMount) mutates it on reload.
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

  let {
    initialUiState,
    onUiStateCapture = () => {},
  }: {
    readonly initialUiState?: SessionSwitchUiState;
    readonly onUiStateCapture?: (patch: SessionSwitchUiStatePatch) => void;
  } = $props();

  const sessionModel = setSessionModel(new RouteSessionDataModel());
  // The runtime helpers retain their legacy string-indexed model contract; this
  // is the same SessionDataModel object, not a wrapper or retained second model.
  // oxlint-disable-next-line pican/no-double-cast -- typed compatibility boundary for the legacy helper contract; runtime identity is unchanged
  const runtimeSessionModel = sessionModel as unknown as Parameters<
    typeof hydrateSessionModel
  >[0]['sessionModel'];

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
  let cwd = $state('');
  let chatAvailable = $state(true);
  let chatDisabledReason = $state('');
  let modelLabel = $state('');
  let runtime = $state('pi');
  let runtimeLabel = $state('Pi');
  let capabilities = $state<CompleteRuntimeCapabilities>(defaultRuntimeCapabilities('pi'));
  let projectionMode = $state('');
  let resumeCommand = $state('');
  let nativeId = $state('');
  let archived = $state(false);
  let waiting = $state(false);
  let sessionTabsEnabled = $state(false);
  let dataEl = $state<HTMLScriptElement | null>(null);
  // Set when a subagent card hands off into the child transcript with a
  // `parent` param — lets the header offer a one-click way back to the parent.
  let parentSession = $state(
    parentSessionParam(typeof window === 'undefined' ? '' : window.location.search),
  );

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
    sessionTabsEnabled = boolFor({}, SESSION_TABS_SETTING_KEY, false, {
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
        runtimeLabel = state.runtimeLabel;
        capabilities = state.capabilities;
        projectionMode = state.projectionMode;
        resumeCommand = state.resumeCommand;
        nativeId = state.nativeId;
        archived = state.archived;
        waiting = state.waiting;
        document.title =
          runtime !== 'pi'
            ? t('session.runtimePageTitle', { title, runtime: runtimeLabel || runtime })
            : title;
        if (document.body) {
          document.body.dataset.runtime = runtime;
          if (nativeId) document.body.dataset.nativeId = nativeId;
          else delete document.body.dataset.nativeId;
        }
        cwd = state.cwd;
        payloadBase64 = state.payloadBase64;
        chatAvailable = state.chatAvailable;
        chatDisabledReason = state.chatDisabledReason;
        modelLabel = state.modelLabel;
        hydrateSessionModel({
          sessionModel: runtimeSessionModel,
          payloadBase64,
          locationSearch: window.location.search,
          windowImpl: window,
        });
        createLiveSessionRuntime({
          sessionModel: runtimeSessionModel,
          contentRuntime,
          documentImpl: document,
        });
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
          onSettingsHydrated: () => {
            if (!active) return;
            sessionTabsEnabled = boolFor({}, SESSION_TABS_SETTING_KEY, false, {
              storage: window.localStorage,
            });
          },
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
    <p><a href={withBasePath('/')}>{t('session.backToSessions')}</a></p>
  </div>
{:else}
  <SessionShell
    {sessionModel}
    {contentRuntime}
    {sessionId}
    {title}
    {cwd}
    {chatAvailable}
    {chatDisabledReason}
    {modelLabel}
    {runtime}
    {runtimeLabel}
    {capabilities}
    {projectionMode}
    {resumeCommand}
    {nativeId}
    {archived}
    {waiting}
    {sessionTabsEnabled}
    {parentSession}
    {initialUiState}
    {onUiStateCapture}
    onArchiveChange={(next: boolean) => (archived = next)}
    bind:dataEl
  />
{/if}
