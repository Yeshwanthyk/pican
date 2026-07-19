<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../shared/strings';
  import { icon, Trash2 } from '../../shared/icons';
  import {
    defaultFetchPeers,
    defaultFetchPeerSessions,
    defaultRemovePeer,
    defaultUpsertPeer,
  } from '../../index/peers';
  import type { PeerList } from '../../lib/schema';
  import { settle } from '../shared/ui-effect';

  type Peer = PeerList['peers'][number];
  let peers = $state<ReadonlyArray<Peer>>([]);
  let onlineByName = $state<Record<string, boolean>>({});
  let loading = $state(true);
  let error = $state('');
  let busy = $state(false);

  let name = $state('');
  let baseUrl = $state('');
  let token = $state('');

  // checkOnline is a lightweight, best-effort re-use of the same aggregated
  // endpoint the homepage polls — a failure here just leaves the dot in its
  // last-known state rather than surfacing as a page error.
  async function checkOnline() {
    const result = await settle(defaultFetchPeerSessions);
    if (result.ok) {
      const next: Record<string, boolean> = {};
      for (const host of result.value.hosts || []) next[host.name] = !!host.online;
      onlineByName = next;
    }
  }

  async function refresh() {
    error = '';
    const result = await settle(defaultFetchPeers);
    if (result.ok) {
      peers = result.value.peers;
    } else {
      error = t('settings.machineFailedLoad');
    }
    loading = false;
    if (peers.length > 0) checkOnline();
  }

  async function addPeer() {
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim();
    if (!trimmedName) {
      error = t('settings.machineNameRequired');
      return;
    }
    if (!trimmedUrl) {
      error = t('settings.machineUrlRequired');
      return;
    }
    busy = true;
    error = '';
    const result = await settle(() => defaultUpsertPeer(trimmedName, trimmedUrl, token.trim()));
    if (result.ok) {
      name = '';
      baseUrl = '';
      token = '';
      await refresh();
    } else {
      error = t('settings.machineFailedSave');
    }
    busy = false;
  }

  async function removePeer(peerName: string) {
    busy = true;
    error = '';
    const result = await settle(() => defaultRemovePeer(peerName));
    if (result.ok) {
      await refresh();
    } else {
      error = t('settings.machineFailedRemove');
    }
    busy = false;
  }

  onMount(() => {
    refresh();
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG -->

<section class="settings-section">
  <div class="settings-section-title">{t('settings.machines')}</div>
  <p class="settings-machines-hint">{t('settings.machinesHint')}</p>

  {#if !loading && peers.length === 0}
    <div class="settings-machines-empty">{t('settings.machineNoneYet')}</div>
  {:else if peers.length > 0}
    <div class="settings-machines-list">
      {#each peers as peer (peer.name)}
        <div class="settings-machine-row">
          <span
            class="settings-machine-dot"
            class:online={!!onlineByName[peer.name]}
            aria-hidden="true"
          ></span>
          <div class="settings-machine-info">
            <span class="settings-machine-name">{peer.name}</span>
            <span class="settings-machine-url">{peer.baseUrl}</span>
          </div>
          <span class="settings-machine-token-state">
            {peer.hasToken ? t('settings.machineTokenSet') : t('settings.machineTokenNotSet')}
          </span>
          <button
            type="button"
            class="settings-machine-remove"
            disabled={busy}
            aria-label={t('settings.machineRemove')}
            onclick={() => removePeer(peer.name)}>{@html icon(Trash2, { size: 14 })}</button
          >
        </div>
      {/each}
    </div>
  {/if}

  <div class="settings-row settings-row-stacked">
    <div class="settings-row-label">
      <span class="name">{t('settings.machineAdd')}</span>
    </div>
    <div class="settings-control settings-control-stacked settings-machine-form">
      <input
        type="text"
        placeholder={t('settings.machineNamePlaceholder')}
        aria-label={t('settings.machineName')}
        bind:value={name}
      />
      <input
        type="text"
        placeholder={t('settings.machineBaseUrlPlaceholder')}
        aria-label={t('settings.machineBaseUrl')}
        bind:value={baseUrl}
      />
      <input
        type="password"
        placeholder={t('settings.machineTokenPlaceholder')}
        aria-label={t('settings.machineToken')}
        bind:value={token}
      />
      <div class="settings-machines-actions">
        <button type="button" class="btn-primary" disabled={busy} onclick={addPeer}
          >{t('settings.machineAdd')}</button
        >
      </div>
      {#if error}
        <div class="settings-machines-error">{error}</div>
      {/if}
    </div>
  </div>
</section>
