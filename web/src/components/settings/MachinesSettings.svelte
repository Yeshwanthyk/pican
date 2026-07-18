<script>
  import { onMount } from 'svelte';
  import { t } from '../../shared/i18n.js';
  import { icon, Trash2 } from '../../shared/icons.js';
  import {
    defaultFetchPeers,
    defaultFetchPeerSessions,
    defaultRemovePeer,
    defaultUpsertPeer,
  } from '../../index/peers.js';

  let peers = $state([]);
  let onlineByName = $state({});
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
    try {
      const response = await defaultFetchPeerSessions();
      const next = {};
      for (const host of response.hosts || []) next[host.name] = !!host.online;
      onlineByName = next;
    } catch {
      // Keep last-known online state.
    }
  }

  async function refresh() {
    error = '';
    try {
      const response = await defaultFetchPeers();
      peers = Array.isArray(response.peers) ? response.peers : [];
    } catch (err) {
      error = err.message || t('settings.machineFailedLoad');
    } finally {
      loading = false;
    }
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
    try {
      await defaultUpsertPeer(trimmedName, trimmedUrl, token.trim());
      name = '';
      baseUrl = '';
      token = '';
      await refresh();
    } catch (err) {
      error = err.message || t('settings.machineFailedSave');
    } finally {
      busy = false;
    }
  }

  async function removePeer(peerName) {
    busy = true;
    error = '';
    try {
      await defaultRemovePeer(peerName);
      await refresh();
    } catch (err) {
      error = err.message || t('settings.machineFailedRemove');
    } finally {
      busy = false;
    }
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
        <div class="settings-custom-languages-status is-error">{error}</div>
      {/if}
    </div>
  </div>
</section>
