<script>
  import { t } from '../../shared/i18n.js';

  let { status = '' } = $props();

  const label = $derived.by(() => {
    const key = `workflows.status.${status}`;
    const translated = t(key);
    return translated === key
      ? String(status || t('workflows.status.unknown')).replaceAll('_', ' ')
      : translated;
  });
</script>

<span class="workflow-status-chip" data-status={status || 'unknown'}>
  {#if status === 'running'}<span class="workflow-status-pulse" aria-hidden="true"></span>{/if}
  {label}
</span>
