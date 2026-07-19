<script>
  import { onMount } from 'svelte';
  import { t } from '../../../shared/strings.js';
  import { extensionRequestExpiresAt } from './extension-ui-state.js';

  let { request, sessionId, onResolved = () => {}, fetchImpl = globalThis.fetch } = $props();

  let value = $state('');
  let submitting = $state(false);
  let failed = $state(false);
  let remainingMs = $state(0);
  let expired = $state(false);

  const expiresAt = $derived(extensionRequestExpiresAt(request));
  const countdown = $derived(Math.max(0, Math.ceil(remainingMs / 1000)));
  const disabled = $derived(submitting || expired);

  async function respond(fields) {
    if (disabled) return;
    submitting = true;
    failed = false;
    try {
      const response = await fetchImpl('/api/extension-ui/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionId, id: request.id, ...fields }),
      });
      if (!response.ok) throw new Error('extension UI response failed');
      onResolved(request.id);
    } catch {
      failed = true;
      submitting = false;
    }
  }

  onMount(() => {
    if (request?.method === 'editor') value = request?.prefill || '';
    if (expiresAt === null) return;
    const update = () => {
      remainingMs = Math.max(0, expiresAt - Date.now());
      if (remainingMs === 0 && !expired) {
        expired = true;
        onResolved(request.id);
      }
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  });
</script>

<section class="extension-ui-card" aria-label={request.title || t('extensionUi.title')}>
  <header class="extension-ui-header">
    <strong>{request.title || t('extensionUi.title')}</strong>
    {#if expiresAt !== null && !expired}
      <span class="extension-ui-countdown">{t('extensionUi.timeout', { seconds: countdown })}</span>
    {/if}
  </header>

  {#if request.message}<p class="extension-ui-message">{request.message}</p>{/if}

  {#if request.method === 'select'}
    <div class="extension-ui-options">
      {#each request.options || [] as option (option)}
        <button type="button" {disabled} onclick={() => respond({ value: option })}>{option}</button
        >
      {/each}
    </div>
    <div class="extension-ui-actions">
      <button
        type="button"
        class="secondary"
        {disabled}
        onclick={() => respond({ cancelled: true })}>{t('common.cancel')}</button
      >
    </div>
  {:else if request.method === 'confirm'}
    <div class="extension-ui-actions">
      <button type="button" {disabled} onclick={() => respond({ confirmed: true })}
        >{t('extensionUi.confirm')}</button
      >
      <button
        type="button"
        class="secondary"
        {disabled}
        onclick={() => respond({ confirmed: false })}>{t('common.cancel')}</button
      >
    </div>
  {:else if request.method === 'input'}
    <input bind:value placeholder={request.placeholder || ''} {disabled} />
    <div class="extension-ui-actions">
      <button type="button" {disabled} onclick={() => respond({ value })}
        >{t('extensionUi.send')}</button
      >
      <button
        type="button"
        class="secondary"
        {disabled}
        onclick={() => respond({ cancelled: true })}>{t('common.cancel')}</button
      >
    </div>
  {:else if request.method === 'editor'}
    <textarea bind:value rows="5" {disabled}></textarea>
    <div class="extension-ui-actions">
      <button type="button" {disabled} onclick={() => respond({ value })}
        >{t('extensionUi.send')}</button
      >
      <button
        type="button"
        class="secondary"
        {disabled}
        onclick={() => respond({ cancelled: true })}>{t('common.cancel')}</button
      >
    </div>
  {/if}

  {#if failed}<div class="extension-ui-error" role="alert">{t('extensionUi.failed')}</div>{/if}
</section>
