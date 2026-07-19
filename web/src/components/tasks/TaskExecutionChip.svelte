<script lang="ts">
  import { t } from '../../shared/strings';

  let { status = '' }: { status?: string } = $props();
  const normalized = $derived(String(status || '').toLowerCase());
  const label = $derived(t(`tasks.execution.${normalized || 'unknown'}`));
</script>

<span class="task-execution-chip" data-status={normalized || 'unknown'}>
  {#if normalized === 'running'}<span class="task-execution-pulse" aria-hidden="true"></span>{/if}
  {label}
</span>
