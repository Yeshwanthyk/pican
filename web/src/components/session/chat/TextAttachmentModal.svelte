<script>
  import { t } from '../../../shared/i18n.js';
  import { icon, X } from '../../../shared/icons.js';
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

<div id="pi-chat-attachment-modal" class="pi-chat-attachment-modal" hidden>
  <div class="pi-chat-attachment-backdrop" data-action="close-attachment"></div>
  <div
    class="pi-chat-attachment-card"
    role="dialog"
    aria-modal="true"
    aria-label={t('composer.attachmentText')}
  >
    <div class="pi-chat-attachment-card-header">
      <span class="pi-chat-attachment-card-title">{t('composer.attachmentText')}</span>
      <button
        type="button"
        class="pi-chat-attachment-card-close"
        data-action="close-attachment"
        aria-label={t('common.close')}>{@html icon(X, { size: 15 })}</button
      >
    </div>
    <pre class="pi-chat-attachment-card-quote"></pre>
    <div class="pi-chat-attachment-card-note" hidden></div>
  </div>
</div>
