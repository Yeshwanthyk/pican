<script lang="ts">
  import { onMount } from 'svelte';
  import * as Http from '../../lib/http.js';
  import { describeError } from '../../lib/errors.js';
  import { runPromise } from '../../lib/runtime.js';
  import { NewSessionResponseSchema } from '../../lib/schema.js';
  import {
    icon,
    ArrowLeft,
    PanelLeft,
    Plus,
    SquarePen,
    MoreHorizontal,
    ChevronDown,
  } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';
  import { navigate, handleNavClick } from '../../shared/navigation.js';
  import { showToast } from '../../shared/toast.js';
  import { copyToClipboard } from '../../shared/clipboard.js';
  import { sessionTitle, setSessionTitle } from '../../session/session-title.svelte.js';
  import { openTree } from '../../session/session-modals.svelte.js';
  import {
    defaultRuntimeCapabilities,
    type CompleteRuntimeCapabilities,
  } from '../../lib/runtime-capabilities.js';
  let {
    title = 'Session',
    cwd = '',
    sessionId = '',
    runtime = 'pi',
    runtimeLabel = '',
    capabilities = defaultRuntimeCapabilities('pi'),
    resumeCommand = '',
    nativeId = '',
    chatAvailable = true,
    workerStatus = { state: 'idle' },
  }: {
    title?: string;
    cwd?: string;
    sessionId?: string;
    runtime?: string;
    runtimeLabel?: string;
    capabilities?: CompleteRuntimeCapabilities;
    resumeCommand?: string;
    nativeId?: string;
    chatAvailable?: boolean;
    workerStatus?: { readonly state: string; readonly exitCode?: number };
  } = $props();

  const safeResumeCommand = $derived(capabilities.resume ? resumeCommand : '');
  const displayRuntimeLabel = $derived(
    runtimeLabel ||
      (runtime === 'pi' ? t('runtime.pi') : runtime === 'codex' ? t('runtime.codex') : runtime),
  );
  const runtimeMark = $derived(
    runtime === 'codex'
      ? { src: '/codex-icon.svg', label: t('runtime.codex') }
      : runtime === 'pi'
        ? { src: '/pi-icon.svg', label: t('runtime.pi') }
        : { src: '', label: displayRuntimeLabel },
  );

  // The title prop seeds the shared store (and re-seeds it on session switch);
  // renames/auto-titling update the store, which this component renders and
  // mirrors into document.title.
  $effect(() => setSessionTitle(title));
  $effect(() => {
    if (!sessionTitle.name) return;
    document.title =
      runtime !== 'pi'
        ? t('session.runtimePageTitle', {
            title: sessionTitle.name,
            runtime: displayRuntimeLabel,
          })
        : sessionTitle.name;
  });

  // Resume ("Terminal") + New Session behavior, absorbed from the former
  // live/resume-button.js and live/new-session-button.js (Svelte migration
  // Phase 3). These are hidden command-relay buttons that the command menu and
  // header buttons .click() by id; live-only (export omits this header).

  async function copyText(text: string, onCopied: () => void): Promise<void> {
    if (await copyToClipboard(text)) onCopied();
  }

  // Passive "Copied" toast — does NOT mutate the resume button's own text.
  function showResumeCopiedNotice(command: string): void {
    showToast(t('common.copied'), { id: 'resume-copy-notice', duration: 1200, title: command });
  }

  const newSessionToast = (text: string): void => {
    showToast(text, { id: 'new-session-toast', duration: 2500 });
  };

  onMount(() => {
    const resumeBtn = document.getElementById('resume-btn');
    const newElement = document.getElementById('new-btn');
    const newBtn = newElement instanceof HTMLButtonElement ? newElement : null;

    const onResume = (): void => {
      if (!safeResumeCommand) {
        showToast(t('session.resumeUnavailable'));
        return;
      }
      void copyText(safeResumeCommand, () => showResumeCopiedNotice(safeResumeCommand));
    };

    const onNew = (): void => {
      if (!cwd) {
        newSessionToast(t('session.noWorkingDirectory'));
        return;
      }
      if (!capabilities.create) return;
      if (!newBtn) return;
      const originalHTML = newBtn.innerHTML;
      newBtn.innerHTML = '<span class="working-dots"></span>';
      newBtn.disabled = true;
      const restore = (): void => {
        newBtn.innerHTML = originalHTML;
        newBtn.disabled = false;
      };
      void runPromise(
        Http.post(
          '/api/new-session',
          { path: cwd, sourceSessionId: sessionId, runtime },
          NewSessionResponseSchema,
        ),
      ).then(
        (data) => {
          navigate('/session?id=' + encodeURIComponent(data.id));
        },
        (error: unknown) => {
          newSessionToast(describeError(error) || t('index.networkError'));
          restore();
        },
      );
    };

    resumeBtn?.addEventListener('click', onResume);
    newBtn?.addEventListener('click', onNew);
    return () => {
      resumeBtn?.removeEventListener('click', onResume);
      newBtn?.removeEventListener('click', onNew);
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div style="display:none">
  <button id="theme-toggle" title="Toggle light/dark theme">Theme</button>
  <button id="notify-toggle" title="Notify when response is ready" aria-pressed="false"
    >Notify</button
  >
  <button
    id="resume-btn"
    disabled={!safeResumeCommand}
    title={safeResumeCommand
      ? t('session.copyResumeCommand', { command: safeResumeCommand })
      : t('session.resumeUnavailable')}>Terminal</button
  >
  <button id="new-btn" title="New Session" disabled={!capabilities.create}>Session</button>
  <button id="share-btn" title="Share session as GitHub Gist">Share</button>
</div>

<div class="session-header-bar">
  <div class="session-header-left">
    <a href="/" class="session-header-back" onclick={(event) => handleNavClick(event, '/')}
      ><span aria-hidden="true">{@html icon(ArrowLeft, { size: 14 })}</span>
      {t('session.back')}</a
    >
    <button
      id="tree-toggle"
      class="session-header-actions session-header-tree-toggle"
      title={t('session.toggleTree')}
      aria-label={t('session.toggleTree')}
      aria-haspopup="dialog"
      onclick={() => openTree()}>{@html icon(PanelLeft, { size: 14 })}</button
    >
  </div>
  <button
    type="button"
    class="session-header-title"
    id="session-header-title"
    popovertarget="pinned-session-switcher"
    popovertargetaction="toggle"
    aria-label={t('session.openPinnedSessions')}
    title={t('session.openPinnedSessions')}
  >
    <span
      class="session-header-runtime"
      title={runtime === 'codex' && nativeId
        ? t('session.nativeIdTitle', { id: nativeId })
        : runtimeMark.label}
    >
      {#if runtimeMark.src}<img
          class="session-header-runtime-mark"
          src={runtimeMark.src}
          alt=""
          aria-hidden="true"
        />{:else}<span class="session-header-runtime-mark" aria-hidden="true"
          >{runtimeMark.label.slice(0, 1).toUpperCase()}</span
        >{/if}
    </span>
    <span class="session-header-title-text">{sessionTitle.name || title}</span>
    {#if workerStatus.state === 'error'}
      <span class="session-header-state session-header-state--danger"
        >{t('session.workerDown')}</span
      >
    {:else if !chatAvailable}
      <span class="session-header-state session-header-state--attention"
        >{t('session.viewOnly')}</span
      >
    {/if}
    <span class="session-header-title-chevron" aria-hidden="true"
      >{@html icon(ChevronDown, { size: 12 })}</span
    >
  </button>
  <div class="session-header-right">
    {#if capabilities.create}<button
        id="new-session-header-btn"
        class="session-header-new"
        title={`${t('index.newSession')} (⌘T)`}
        aria-label={t('session.newSession')}
        >{@html icon(Plus, { size: 14 })}<span class="session-header-new-label"
          >{t('session.new')}</span
        ></button
      >{/if}
    <button
      id="shortcuts-help-btn"
      class="session-header-shortcuts-help"
      title={`${t('session.shortcuts')} (⌘/)`}>⌘/</button
    >
    <button
      id="toggle-right-sidebar-btn"
      class="session-header-actions"
      title={`${t('session.toggleScratchpad')} (⌘⇧N)`}
      aria-label={t('session.toggleScratchpad')}>{@html icon(SquarePen, { size: 14 })}</button
    >
    <button
      id="command-menu-btn"
      class="session-header-actions"
      aria-label={t('session.actions')}
      aria-haspopup="menu"
      aria-expanded="false"
      aria-controls="command-menu-popover">{@html icon(MoreHorizontal, { size: 16 })}</button
    >
  </div>
</div>
