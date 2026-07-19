<script lang="ts">
  import { t } from '../../shared/strings';

  let { status = '' }: { status?: string } = $props();

  const label = $derived.by(() => {
    const key = `workflows.status.${status}`;
    const value = t(key);
    return value === key
      ? String(status || t('workflows.status.unknown')).replaceAll('_', ' ')
      : value;
  });
</script>

<span class="workflow-status-chip" data-status={status || 'unknown'}>
  {#if status === 'running'}<span class="workflow-status-pulse" aria-hidden="true"></span>{/if}
  {label}
</span>
