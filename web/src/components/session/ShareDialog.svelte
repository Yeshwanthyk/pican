<script lang="ts">
  // Share dialog — Svelte port of live/share-overlay.js. Wires the hidden
  // #share-btn relay (in SessionHeader) to POST /share, then shows the gist /
  // preview URLs (or an error) in a reactive overlay with copy-to-clipboard.
  // Live-only (the export snapshot omits #share-btn). See svelte-migration-plan.
  import { Schema } from 'effect';
  import { onMount } from 'svelte';
  import * as Http from '../../lib/http.js';
  import { describeError } from '../../lib/errors.js';
  import { runPromise } from '../../lib/runtime.js';
  import { icon, Share2 } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';
  import { showToast } from '../../shared/toast.js';
  import { copyToClipboard } from '../../shared/clipboard.js';

  let { sessionId = '' }: { sessionId?: string } = $props();

  const ShareResponse = Schema.Struct({
    error: Schema.optionalKey(Schema.String),
    stderr: Schema.optionalKey(Schema.String),
    gistUrl: Schema.optionalKey(Schema.String),
    previewUrl: Schema.optionalKey(Schema.String),
  });

  let open = $state(false);
  let isError = $state(false);
  let title = $state(t('share.defaultTitle'));
  let gistUrl = $state('');
  let previewUrl = $state('');
  let errorMsg = $state('');
  let overlayEl = $state<HTMLDivElement | null>(null);

  function showShareCopiedNotice(label: string, text: string): void {
    showToast(t('share.copiedSuffix', { label }), {
      id: 'share-copy-notice',
      duration: 1200,
      title: text,
    });
  }

  async function copyShareUrl(text: string, label: string): Promise<void> {
    if (await copyToClipboard(text)) showShareCopiedNotice(label, text);
  }

  function close(): void {
    open = false;
  }

  onMount(() => {
    const shareElement = document.getElementById('share-btn');
    const shareBtn = shareElement instanceof HTMLButtonElement ? shareElement : null;
    const onShare = (): void => {
      if (!shareBtn) return;
      shareBtn.innerHTML = '<span class="working-dots"></span>';
      shareBtn.disabled = true;
      const restore = (): void => {
        shareBtn.innerHTML = icon(Share2, { size: 14 }) + t('menu.share');
        shareBtn.disabled = false;
      };
      void runPromise(
        Http.post('/share?id=' + encodeURIComponent(sessionId), undefined, ShareResponse),
      ).then(
        (data) => {
          restore();
          if (data.error) {
            isError = true;
            title = t('share.failedTitle');
            errorMsg = data.error + (data.stderr ? '\n\n' + data.stderr : '');
          } else {
            isError = false;
            title = t('share.successTitle');
            gistUrl = data.gistUrl ?? '';
            previewUrl = data.previewUrl ?? '';
          }
          open = true;
        },
        (error: unknown) => {
          restore();
          isError = true;
          title = t('share.failedTitle');
          errorMsg = describeError(error) || t('share.networkError');
          open = true;
        },
      );
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && open) close();
    };
    const onBackdrop = (e: MouseEvent): void => {
      if (e.target === overlayEl) close();
    };

    shareBtn?.addEventListener('click', onShare);
    document.addEventListener('keydown', onKey);
    overlayEl?.addEventListener('click', onBackdrop);
    return () => {
      shareBtn?.removeEventListener('click', onShare);
      document.removeEventListener('keydown', onKey);
      overlayEl?.removeEventListener('click', onBackdrop);
    };
  });
</script>

<div
  id="share-overlay"
  class="share-overlay-backdrop"
  style:display={open ? '' : 'none'}
  bind:this={overlayEl}
>
  <div id="share-dialog" class="share-dialog" class:error={isError}>
    <h3 id="share-title">{title}</h3>
    <div id="share-fields" style:display={isError ? 'none' : ''}>
      <div class="share-field">
        <label for="share-gist-url">{t('share.gistUrlLabel')}</label><input
          id="share-gist-url"
          readonly
          class="share-url-input"
          value={gistUrl}
        />
      </div>
      <div class="share-field">
        <label for="share-preview-url">{t('share.previewUrlLabel')}</label><input
          id="share-preview-url"
          readonly
          class="share-url-input"
          value={previewUrl}
        />
      </div>
    </div>
    <p id="share-error-message" class="share-error-message" style:display={isError ? '' : 'none'}>
      {errorMsg}
    </p>
    <div class="share-actions">
      <button
        id="share-copy-gist"
        class="share-btn-primary"
        style:display={isError ? 'none' : ''}
        onclick={() => void copyShareUrl(gistUrl, t('share.gistLabel'))}
        >{t('share.copyGist')}</button
      >
      <button
        id="share-copy-preview"
        class="share-btn-secondary"
        style:display={isError ? 'none' : ''}
        onclick={() => void copyShareUrl(previewUrl, t('share.previewLabel'))}
        >{t('share.copyPreview')}</button
      >
      <button id="share-close" class="share-btn-secondary" onclick={close}
        >{t('common.close')}</button
      >
    </div>
  </div>
</div>
<div id="share-copy-notice" class="toast-notice"></div>
