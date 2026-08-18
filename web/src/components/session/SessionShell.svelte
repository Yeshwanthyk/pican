<script lang="ts">
  import { onDestroy } from 'svelte';
  import ChatComposer from './ChatComposer.svelte';
  import LiveReload from './LiveReload.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import CommandMenu from './CommandMenu.svelte';
  import RightSidebar from './RightSidebar.svelte';
  import SessionHeader from './SessionHeader.svelte';
  import SessionInfoHeader from './SessionInfoHeader.svelte';
  import SessionContent from './SessionContent.svelte';
  import SessionActivityDock from './SessionActivityDock.svelte';
  import ImageModal from './ImageModal.svelte';
  import ShortcutsModal from './ShortcutsModal.svelte';
  import ModelUsageModal from './ModelUsageModal.svelte';
  import ForkModal from './ForkModal.svelte';
  import DiffModal from './DiffModal.svelte';
  import LoadEarlier from './LoadEarlier.svelte';
  import SessionTree from './SessionTree.svelte';
  import ShareDialog from './ShareDialog.svelte';
  import PinnedSessionSwitcher from './PinnedSessionSwitcher.svelte';
  import PinnedTabsStrip from './PinnedTabsStrip.svelte';
  import { normalizeSession } from '../../index/sessions.js';
  import { PinnedTabsModel } from '../../session/pinned-tabs-model.svelte.js';
  import { sessionTitle } from '../../session/session-title.svelte.js';
  import {
    sessionModals,
    hasDiffUrlParam,
    syncDiffUrlParam,
    hasTreeUrlParam,
    syncTreeUrlParam,
  } from '../../session/session-modals.svelte.js';
  import { getSessionRuntime } from '../../session/session-runtime-context.js';
  import type { WorkerProcessStatus } from '../../session/data/session-types.js';
  import type { SessionConnectionState } from '../../session/live/live-connection.js';
  import type {
    SessionSwitchUiState,
    SessionSwitchUiStatePatch,
  } from '../../session/session-switch-state.js';
  import { defaultRuntimeCapabilities } from '../../lib/runtime-capabilities.js';
  import { copyToClipboard } from '../../shared/clipboard.js';

  let {
    sessionModel,
    contentRuntime,
    sessionId = '',
    title = 'Session',
    scratchpad = '',
    cwd = '',
    chatAvailable = true,
    chatDisabledReason = '',
    modelLabel = '',
    runtime = 'pi',
    runtimeLabel = 'Pi',
    capabilities = defaultRuntimeCapabilities('pi'),
    projectionMode = '',
    resumeCommand = '',
    nativeId = '',
    archived = false,
    waiting = false,
    sessionTabsEnabled = false,
    parentSession = '',
    initialUiState = undefined as SessionSwitchUiState | undefined,
    onUiStateCapture = (() => {}) as (patch: SessionSwitchUiStatePatch) => void,
    onArchiveChange = null,
    dataEl = $bindable(null),
  } = $props();

  const liveRuntime = getSessionRuntime();
  let connectionState = $state<SessionConnectionState>('connecting');
  const workerStatus = $derived(
    (sessionModel.workerStatus ?? { state: 'idle' }) as WorkerProcessStatus,
  );
  const workerDown = $derived(workerStatus.state === 'error');
  const running = $derived(workerStatus.state === 'running');
  const pinnedTabs = new PinnedTabsModel('');
  const currentSession = $derived(
    pinnedTabs.sessions.find((session) => session.id === sessionId) ??
      normalizeSession({
        id: sessionId,
        name: sessionTitle.name || title,
        project: cwd,
        runtime,
        nativeId,
        chatAvailable,
        chatDisabledReason,
        archived,
        waitingQuestion: waiting ? 'waiting' : '',
      }),
  );

  $effect(() => {
    pinnedTabs.setCurrentSessionId(sessionId);
    if (sessionTabsEnabled) pinnedTabs.start();
    else pinnedTabs.setEnabled(false);
    document.body?.classList.toggle('has-session-tabs', sessionTabsEnabled);
  });

  onDestroy(() => {
    pinnedTabs.dispose();
    document.body?.classList.remove('has-session-tabs');
  });

  // Restore the diff sheet from `?diff=open` on first load. Must seed
  // sessionModals.diff before the sync $effect runs, or that effect would see
  // open=false on first tick and strip the param before we read it. sessionId
  // is a $state prop in <SessionPage> set inside its own onMount, so we wait
  // for it (and only restore once).
  let diffRestored = false;
  $effect(() => {
    if (diffRestored || !sessionId) return;
    diffRestored = true;
    if (hasDiffUrlParam()) {
      sessionModals.diff.sessionId = sessionId;
      sessionModals.diff.open = true;
    }
  });

  // Mirror the modal's open state into the URL so a refresh restores the
  // sheet. Covers every close path (Escape, backdrop, mobile back-button),
  // since they all flip sessionModals.diff.open.
  $effect(() => {
    if (!diffRestored) return;
    syncDiffUrlParam(sessionModals.diff.open);
  });

  // Same restore/sync pattern for the tree overlay's `?tree=open`.
  let treeRestored = false;
  $effect(() => {
    if (treeRestored) return;
    treeRestored = true;
    if (hasTreeUrlParam()) sessionModals.tree.open = true;
  });

  $effect(() => {
    if (!treeRestored) return;
    syncTreeUrlParam(sessionModals.tree.open);
  });
</script>

<SessionHeader
  {title}
  {cwd}
  {sessionId}
  {runtime}
  {runtimeLabel}
  {capabilities}
  {resumeCommand}
  {nativeId}
  {chatAvailable}
  {workerStatus}
  {parentSession}
  pinnedNavigationEnabled={sessionTabsEnabled}
/>
{#if !sessionTabsEnabled}
  <PinnedSessionSwitcher model={pinnedTabs} {currentSession} {onArchiveChange} />
{/if}
{#if sessionTabsEnabled}
  <PinnedTabsStrip
    model={pinnedTabs}
    {currentSession}
    currentRunning={running}
    currentWaiting={waiting}
    canCreate={capabilities.create}
    {onArchiveChange}
  />
{/if}

<CommandMenu
  {sessionId}
  {cwd}
  {capabilities}
  {resumeCommand}
  {archived}
  {running}
  {waiting}
  {onArchiveChange}
/>

<!-- Live reload (SSE) mounts before <ChatComposer> so its optimistic
     "message sent" listener is attached before the user can send. -->
<LiveReload
  initialState={initialUiState
    ? {
        scrollTop: initialUiState.transcriptScrollTop,
        following: initialUiState.following,
      }
    : undefined}
  onStateCapture={(state) =>
    onUiStateCapture({
      transcriptScrollTop: state.scrollTop,
      following: state.following,
    })}
  onConnectionState={(state) => (connectionState = state)}
/>
<ConnectionStatus state={connectionState} />

<div id="app" class:worker-down={workerDown}>
  <div id="content-container" class="content-container">
    <main id="content">
      <div id="header-container"><SessionInfoHeader model={sessionModel} /></div>
      <LoadEarlier model={sessionModel} {sessionId} navigateTo={liveRuntime.navigateTo} />
      <div id="messages">
        <SessionContent
          model={sessionModel}
          afterRender={contentRuntime.afterRender}
          live
          {modelLabel}
          {sessionId}
          canFork={capabilities.fork}
          copyText={copyToClipboard}
        />
      </div>
    </main>
    <SessionActivityDock {sessionId} projectPath={cwd} {chatAvailable} />
    <ChatComposer
      {sessionId}
      {chatAvailable}
      {chatDisabledReason}
      {cwd}
      {modelLabel}
      {capabilities}
      {resumeCommand}
      {workerStatus}
      initialComposerText={initialUiState?.composerText ?? ''}
      onComposerTextCapture={(composerText) => onUiStateCapture({ composerText })}
      pinnedTabs={sessionTabsEnabled ? pinnedTabs : null}
      {currentSession}
      currentRunning={running}
      currentWaiting={waiting}
      {onArchiveChange}
    />
  </div>
  <RightSidebar {scratchpad} projectPath={cwd} />
  <ImageModal />
</div>

<ShortcutsModal bind:open={sessionModals.shortcuts} />
<ModelUsageModal bind:open={sessionModals.modelUsage} />
<ForkModal
  bind:open={sessionModals.fork.open}
  entries={sessionModals.fork.entries}
  onSelect={sessionModals.fork.onSelect}
/>
<DiffModal bind:open={sessionModals.diff.open} sessionId={sessionModals.diff.sessionId} />
<SessionTree bind:open={sessionModals.tree.open} />

<ShareDialog {sessionId} />
<svelte:element
  this={"script"}
  id="session-data"
  type="application/json"
  data-runtime={runtime}
  data-projection-mode={projectionMode || undefined}
  data-native-id={nativeId || undefined}
  bind:this={dataEl}
></svelte:element>
