<script lang="ts">
  import { t } from '../../shared/strings.js';
  import { icon } from '../../shared/icons.js';
  import { showToast } from '../../shared/toast.js';
  import { describeError } from '../../lib/errors';
  import { Archive, ArchiveRestore } from 'lucide';
  import { settle } from '../shared/ui-effect';
  import {
    defaultUpdateArchive,
    defaultUpdatePin,
    type NormalizedSession,
    type RunningStatus,
  } from '../../index/sessions.js';
  import ActivityRow from './ActivityRow.svelte';

  interface Props {
    session: NormalizedSession;
    running?: boolean;
    runningStatus?: RunningStatus | null;
    now?: number;
  }

  let { session, running = false, runningStatus = null, now = Date.now() }: Props = $props();

  const waiting = $derived(Boolean(session.waitingQuestion));
  let archived = $state(false);
  $effect(() => {
    archived = session.archived;
  });
  const pinLabel = $derived(session.pinned ? t('index.unpinSession') : t('index.pinSession'));
  const archiveLabel = $derived(archived ? t('index.restoreSession') : t('index.archiveSession'));
  const archiveDisabledReason = $derived(
    archived
      ? ''
      : waiting
        ? t('index.archiveDisabledWaiting')
        : running
          ? t('index.archiveDisabledRunning')
          : '',
  );

  let pinBusy = $state(false);
  let archiveBusy = $state(false);

  async function togglePin(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (pinBusy || !session.id) return;
    const next = !session.pinned;
    session.pinned = next;
    pinBusy = true;
    const result = await settle(() => defaultUpdatePin(session.id, next));
    if (!result.ok) {
      session.pinned = !next;
      showToast(describeError(result.error.cause) || t('index.networkError'));
    }
    pinBusy = false;
  }

  async function toggleArchive(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (archiveBusy || archiveDisabledReason || !session.id) return;
    const next = !archived;
    archived = next;
    session.archived = next;
    archiveBusy = true;
    const result = await settle(() => defaultUpdateArchive(session.id, next));
    if (!result.ok) {
      archived = !next;
      session.archived = !next;
      showToast(describeError(result.error.cause) || t('index.archiveUpdateFailed'));
    }
    archiveBusy = false;
  }
</script>

<ActivityRow
  {session}
  {running}
  {runningStatus}
  {now}
  {archived}
  {pinBusy}
  {archiveBusy}
  {archiveDisabledReason}
  archiveIcon={icon(archived ? ArchiveRestore : Archive, { size: 14 })}
  {pinLabel}
  {archiveLabel}
  onTogglePin={togglePin}
  onToggleArchive={toggleArchive}
/>
