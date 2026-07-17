<script>
  import { t } from '../../shared/i18n.js';

  let { status = '' } = $props();
  const normalized = $derived(String(status || '').toLowerCase());
  const label = $derived(t(`tasks.execution.${normalized || 'unknown'}`));
</script>

<span class="task-execution-chip" data-status={normalized || 'unknown'}>
  {#if normalized === 'running'}<span class="task-execution-pulse" aria-hidden="true"></span>{/if}
  {label}
</span>
