<script>
  import { t } from '../../shared/strings.js';
  import { icon, ExternalLink } from '../../shared/icons.js';
  import {
    formatRelativeTime,
    formatSessionMetrics,
    sessionModelLabel,
  } from '../../index/sessions.js';

  // A remote peer's session, read-only: no pin button, no chat-availability
  // badge (that's local-worker state, meaningless for a machine we never
  // talk to), and the card itself is an external link to the peer's own
  // /session page rather than local SPA routing — session ids are bare
  // filenames and are not unique across machines, so there is no safe local
  // route for them. See docs/sequence-flows/peers.md.
  let { session, now = Date.now() } = $props();

  const href = $derived(
    `${session.hostUrl || ''}/session?id=${encodeURIComponent(session.id || '')}`,
  );
  const title = $derived(session.name || session.id || '');
  const modelLabel = $derived(sessionModelLabel(session));
  const metrics = $derived(formatSessionMetrics(session));
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<a
  class="session-card session-card--remote"
  {href}
  target="_blank"
  rel="noopener"
  title={t('index.machineOpenOnHost', { name: session.host || '' })}
  data-id={session.id}
  data-session-id={session.id}
>
  <div class="session-title-row">
    <div class="session-title">{title}</div>
    <div class="session-card-flags">
      <span class="session-card-remote-icon" aria-hidden="true"
        >{@html icon(ExternalLink, { size: 12 })}</span
      >
    </div>
  </div>
  <div class="session-project">{session.project}</div>
  <div class="session-model" data-session-model>{modelLabel}</div>
  <div class="session-meta">
    <span class="session-time" data-timestamp={session.lastActivity} title={session.lastActivity}
      >{formatRelativeTime(session.lastActivity, now)}</span
    >
  </div>
  {#if metrics}
    <div class="session-card-metrics">{metrics}</div>
  {/if}
</a>
