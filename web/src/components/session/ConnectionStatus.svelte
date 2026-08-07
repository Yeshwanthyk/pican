<script lang="ts">
  import { t } from '../../shared/strings.js';
  import type { SessionConnectionState } from '../../session/live/live-connection.js';

  let {
    state: connectionState = 'connecting',
    delayMs = 1200,
  }: { readonly state?: SessionConnectionState; readonly delayMs?: number } = $props();

  let visibleState = $state<Extract<SessionConnectionState, 'reconnecting' | 'stale'> | null>(null);

  $effect(() => {
    visibleState = null;
    if (connectionState !== 'reconnecting' && connectionState !== 'stale') return;
    const pendingState = connectionState;
    const timer = window.setTimeout(() => {
      visibleState = pendingState;
    }, delayMs);
    return () => window.clearTimeout(timer);
  });
</script>

{#if visibleState}
  <div class="connection-status connection-status--{visibleState}" role="status" aria-live="polite">
    <span class="connection-status-dot" aria-hidden="true"></span>
    {visibleState === 'stale' ? t('session.connectionStale') : t('session.connectionReconnecting')}
  </div>
{/if}
