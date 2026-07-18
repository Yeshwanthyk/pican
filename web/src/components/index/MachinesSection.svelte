<script>
  import { icon, ChevronDown } from '../../shared/icons.js';
  import { t } from '../../shared/i18n.js';
  import PeerSessionRow from './PeerSessionRow.svelte';

  let { hosts = [], now = Date.now() } = $props();

  let expanded = $state({});
  const onlineCount = $derived(hosts.filter((h) => h.online).length);

  function toggle(name) {
    expanded = { ...expanded, [name]: !expanded[name] };
  }

  function sessionCountLabel(host) {
    const n = host.sessions.length;
    return n === 1
      ? t('index.machineSessionCountOne')
      : t('index.machineSessionCount', { count: n });
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<div class="timeline-section" data-bucket="machines">
  <div class="date-separator">
    <span class="date-separator-label">{t('index.machines')}</span>
    <span class="date-separator-count"
      >{t('index.machinesOnlineCount', { online: onlineCount, total: hosts.length })}</span
    >
  </div>
  <div class="machines-list">
    {#each hosts as host (host.name)}
      {@const isExpanded = !!expanded[host.name]}
      <div class="machine-block" class:machine-block--expanded={isExpanded}>
        <button
          type="button"
          class="machine-toggle"
          aria-expanded={String(isExpanded)}
          disabled={host.sessions.length === 0}
          onclick={() => toggle(host.name)}
        >
          <span class="machine-chevron" aria-hidden="true"
            >{@html icon(ChevronDown, { size: 12 })}</span
          >
          <span class="machine-dot" class:online={host.online} aria-hidden="true"></span>
          <span class="machine-name">{host.name}</span>
          <span class="machine-status" class:machine-status--error={!host.online}>
            {#if host.online}
              {sessionCountLabel(host)}
            {:else}
              {host.error || t('index.machineOffline')}
            {/if}
          </span>
        </button>
        {#if isExpanded && host.sessions.length > 0}
          <div class="session-grid machine-sessions">
            {#each host.sessions as session (session.host + ':' + session.id)}
              <PeerSessionRow {session} {now} />
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>
