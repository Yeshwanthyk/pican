<script>
  import ChatComposer from './ChatComposer.svelte';
  import LiveReload from './LiveReload.svelte';
  import CommandMenu from './CommandMenu.svelte';
  import RightSidebar from './RightSidebar.svelte';
  import SessionHeader from './SessionHeader.svelte';
  import SessionInfoHeader from './SessionInfoHeader.svelte';
  import SessionContent from './SessionContent.svelte';
  import ImageModal from './ImageModal.svelte';
  import ShortcutsModal from './ShortcutsModal.svelte';
  import ModelUsageModal from './ModelUsageModal.svelte';
  import ForkModal from './ForkModal.svelte';
  import BtwPopup from './BtwPopup.svelte';
  import LabelModal from './LabelModal.svelte';
  import DiffModal from './DiffModal.svelte';
  import LoadEarlier from './LoadEarlier.svelte';
  import SessionTree from './SessionTree.svelte';
  import ShareDialog from './ShareDialog.svelte';
  import {
    sessionModals,
    hasDiffUrlParam,
    syncDiffUrlParam,
    hasTreeUrlParam,
    syncTreeUrlParam,
  } from '../../session/session-modals.svelte.js';
  import { getSessionRuntime } from '../../session/session-runtime-context.js';

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
    nativeId = '',
    sessionUUID = '',
    dataEl = $bindable(null),
  } = $props();

  const liveRuntime = getSessionRuntime();

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

<SessionHeader {title} {cwd} {sessionId} {runtime} {nativeId} {sessionUUID} />

<CommandMenu {sessionId} {cwd} />

<!-- Live reload (SSE) mounts before <ChatComposer> so its optimistic
     "message sent" listener is attached before the user can send. -->
<LiveReload />

<div id="app">
  <div id="content-container" class="content-container">
    <main id="content">
      <div id="header-container"><SessionInfoHeader model={sessionModel} /></div>
      <LoadEarlier model={sessionModel} {sessionId} navigateTo={liveRuntime.navigateTo} />
      <div id="messages">
        <SessionContent model={sessionModel} afterRender={contentRuntime.afterRender} live />
      </div>
    </main>
    <ChatComposer {sessionId} {chatAvailable} {chatDisabledReason} {cwd} {modelLabel} />
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
<LabelModal
  bind:open={sessionModals.label.open}
  entryId={sessionModals.label.entryId}
  currentLabel={sessionModals.label.currentLabel}
  onSave={sessionModals.label.onSave}
/>
<DiffModal bind:open={sessionModals.diff.open} sessionId={sessionModals.diff.sessionId} />
<SessionTree bind:open={sessionModals.tree.open} />

<ShareDialog {sessionId} />
<BtwPopup {cwd} parentId={sessionId} />
<svelte:element
  this={"script"}
  id="session-data"
  type="application/json"
  data-runtime={runtime}
  data-native-id={nativeId || undefined}
  bind:this={dataEl}
></svelte:element>
