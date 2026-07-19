<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { icon, ExternalLink, X } from '../../shared/icons';
  import { t } from '../../shared/strings';
  import {
    cleanVersion,
    fetchVersionInfo,
    registerVersionController,
    renderChangelog,
    versionLabel,
  } from '../../shared/version';
  import type { VersionInfo } from '../../lib/schema';
  import { MutationResponseSchema } from '../../lib/schema';
  import type { FetchLike } from '../../lib/http';
  import * as Http from '../../lib/http';
  import { runPromise } from '../../lib/runtime';
  import { describeError } from '../../lib/errors';
  import { ignoreFailure, settle } from './ui-effect';

  let {
    fetchImpl = null,
    minCheckMs = 450,
  }: { fetchImpl?: FetchLike | null; minCheckMs?: number } = $props();

  let info = $state<VersionInfo | null>(null);
  let open = $state(false);
  let busy = $state(false);
  let checking = $state(false);
  let status = $state('');
  let statusKind = $state('');
  let error = $state('');

  const effectiveFetch = $derived(fetchImpl || window.fetch.bind(window));
  const label = $derived(versionLabel(info));
  const hasUpdate = $derived(!!(info && info.hasUpdate));
  const changelogHtml = $derived(renderChangelog(info?.changelog || ''));

  function applyStatus() {
    document.querySelectorAll('[data-version-status]').forEach((el) => {
      el.textContent = label;
      el.classList.toggle('has-update', hasUpdate);
    });
    document.querySelectorAll('[data-version-row]').forEach((el) => {
      el.classList.toggle('has-update', hasUpdate);
    });
  }

  $effect(() => {
    void label;
    void hasUpdate;
    tick().then(applyStatus);
  });

  async function refresh(force = false): Promise<VersionInfo | null> {
    const result = await settle(() => fetchVersionInfo({ fetchImpl: effectiveFetch, force }));
    if (result.ok) {
      info = result.value;
      error = '';
    } else {
      // Leave current info intact for the row. The modal surfaces check errors.
      if (force) error = t('version.couldNotCheck');
    }
    applyStatus();
    return info;
  }

  function openModal() {
    status = '';
    statusKind = '';
    error = '';
    open = true;
    document.body?.classList.add('version-modal-open');
  }

  function closeModal() {
    if (busy) return;
    open = false;
    document.body?.classList.remove('version-modal-open');
  }

  function setStatus(message: string, kind = '') {
    status = message;
    statusKind = kind;
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function doManualCheck() {
    checking = true;
    error = '';
    const startedAt = Date.now();
    const result = await settle(() => refresh(true));
    if (result.ok) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < minCheckMs) await delay(minCheckMs - elapsed);
    } else {
      error = t('version.couldNotCheck');
    }
    checking = false;
  }

  async function runUpdate() {
    if (busy) return;
    busy = true;
    setStatus(t('version.installing'), 'info');
    const update = await settle(() =>
      runPromise(
        Http.post('/api/update', undefined, MutationResponseSchema, { fetchImpl: effectiveFetch }),
      ),
    );
    if (update.ok) {
      setStatus(t('version.restarting'), 'info');
      ignoreFailure(() =>
        runPromise(
          Http.post('/api/restart', undefined, MutationResponseSchema, {
            fetchImpl: effectiveFetch,
          }),
        ),
      );
      awaitReconnect();
    } else {
      setStatus(t('version.updateFailed', { error: describeError(update.error) }), 'error');
      busy = false;
    }
  }

  function awaitReconnect() {
    setStatus(t('version.reconnecting'), 'info');
    const startedAt = Date.now();
    const maxWaitMs = 90_000;
    const tickReconnect = async () => {
      if (Date.now() - startedAt > maxWaitMs) {
        setStatus(t('version.serverNotBack'), 'error');
        busy = false;
        return;
      }
      const result = await settle(() => fetchVersionInfo({ fetchImpl: effectiveFetch }));
      if (result.ok) {
        window.location.reload();
        return;
      }
      setTimeout(tickReconnect, 1500);
    };
    setTimeout(tickReconnect, 2500);
  }

  function handleRowClick(e: MouseEvent) {
    const row =
      e.target instanceof Element ? e.target.closest<HTMLElement>('[data-version-row]') : null;
    if (!row || row.dataset.action === 'version') return;
    e.preventDefault();
    openModal();
  }

  onMount(() => {
    const controller = { refresh, openModal, closeModal, applyStatus };
    const unregister = registerVersionController(controller);
    document.addEventListener('click', handleRowClick);
    refresh(false);
    return () => {
      unregister();
      document.removeEventListener('click', handleRowClick);
      document.body?.classList.remove('version-modal-open');
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

{#if open}
  <div
    class="version-modal-overlay open"
    role="presentation"
    onclick={(e) => {
      if (e.currentTarget === e.target) closeModal();
    }}
  >
    <div
      class="version-modal"
      role="dialog"
      aria-modal="true"
      aria-label={t('version.dialogLabel')}
    >
      <div class="version-modal-header">
        <span class="version-modal-title">{t('common.productName')}</span>
        <span class="version-modal-current">{info?.current ? cleanVersion(info.current) : ''}</span>
        <button
          type="button"
          class="version-modal-close"
          aria-label={t('common.close')}
          onclick={closeModal}>{@html icon(X, { size: 16 })}</button
        >
      </div>
      <div class="version-modal-body">
        {#if !info}
          <p>{t('version.unavailable')}</p>
        {:else if info.isDev}
          <p>{t('version.devBuild')}</p>
          {#if info.latest}<p class="version-modal-notes">
              {t('version.latestPublished', { version: cleanVersion(info.latest) })}
            </p>{/if}
          <p class="version-modal-notes">{t('version.devUpdateDisabled')}</p>
        {:else if info.hasUpdate}
          <p class="version-modal-lead">
            {t('version.updateAvailable')}
            <strong>{cleanVersion(info.current)} → {cleanVersion(info.latest)}</strong>
          </p>
          <div class="version-changelog">{@html changelogHtml}</div>
          {#if info.changelogUrl}
            <p class="version-modal-notes">
              <a href={info.changelogUrl} target="_blank" rel="noreferrer"
                >{t('version.releaseNotes')} {@html icon(ExternalLink, { size: 12 })}</a
              >
            </p>
          {/if}
        {:else}
          <p>{t('version.onLatest')}</p>
          {#if info.checkedAt}<p class="version-modal-notes">
              {t('version.lastChecked', { when: new Date(info.checkedAt).toLocaleString() })}
            </p>{/if}
        {/if}
      </div>
      <div
        class="version-modal-status"
        class:info={statusKind === 'info'}
        class:error={statusKind === 'error'}
        hidden={!status && !error}
      >
        {error || status}
      </div>
      <div class="version-modal-actions">
        {#if info?.hasUpdate && !info?.isDev}
          <button
            type="button"
            class="version-modal-btn primary"
            disabled={busy}
            onclick={runUpdate}>{t('version.updateRestart')}</button
          >
          <button type="button" class="version-modal-btn ghost" disabled={busy} onclick={closeModal}
            >{t('version.later')}</button
          >
        {:else}
          <button
            type="button"
            class="version-modal-btn ghost"
            class:is-loading={checking}
            disabled={checking || busy}
            onclick={doManualCheck}
            >{checking ? t('version.checking') : t('version.checkForUpdates')}</button
          >
        {/if}
      </div>
    </div>
  </div>
{/if}
