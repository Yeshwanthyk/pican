<script lang="ts">
  // Model Usage modal — Svelte port of live/model-usage-modal.js. Renders token,
  // cost, and per-model breakdowns over <FullScreenSheet>, computed reactively
  // from the shared session model. Opened via the bindable `open` prop.
  // (Labels are kept as the original hardcoded English — a faithful port, not new
  // user-facing strings.)
  import { getSessionModel } from '../../session/session-context.js';
  import { isUnknownRecord, type SessionEntry } from '../../session/data/session-types.js';
  import { computeSessionStats, formatTokens } from '../../session/render/session-stats.js';
  import FullScreenSheet from './FullScreenSheet.svelte';

  interface UsageModel {
    readonly entries: readonly SessionEntry[];
  }

  let {
    open = $bindable(false),
    model = getSessionModel<UsageModel>(),
  }: { open?: boolean; model?: UsageModel } = $props();

  const MODEL_DOT_COLORS = [
    '#8abeb7',
    '#cc6666',
    '#81a2be',
    '#b5bd68',
    '#de935f',
    '#a3685a',
    '#f0c674',
    '#b294bb',
    '#5f819d',
    '#9a7b6b',
  ];

  function formatCost(n: number): string {
    return '$' + (Number.isFinite(n) ? n : 0).toFixed(3);
  }

  function shortenModelName(name: string): string {
    const parts = name.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : name;
  }

  function prettifyModelName(name: string): string {
    return shortenModelName(name)
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c: string) => c.toUpperCase())
      .replace(/\s+\d{4}\d{2}\d{2}$/, ''); // strip date suffix
  }

  interface ModelBreakdown {
    readonly name: string;
    readonly tokens: number;
    readonly percent: number;
  }

  const numberField = (record: Readonly<Record<string, unknown>>, key: string): number =>
    typeof record[key] === 'number' ? record[key] : 0;

  function computeModelBreakdown(entries: readonly SessionEntry[]): ModelBreakdown[] {
    const modelTokens: Record<string, number> = {};
    for (const entry of entries) {
      if (entry?.type !== 'message') continue;
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant' || !msg.model) continue;
      const key = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
      if (!modelTokens[key]) modelTokens[key] = 0;
      if (isUnknownRecord(msg.usage)) {
        modelTokens[key] +=
          numberField(msg.usage, 'input') +
          numberField(msg.usage, 'output') +
          numberField(msg.usage, 'cacheRead') +
          numberField(msg.usage, 'cacheWrite');
      }
    }
    const totalAll = Object.values(modelTokens).reduce((a, b) => a + b, 0);
    return Object.entries(modelTokens)
      .map(([name, tokens]) => ({
        name,
        tokens,
        percent: totalAll > 0 ? (tokens / totalAll) * 100 : 0,
      }))
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);
  }

  const entries = $derived(model?.entries ?? []);
  const stats = $derived(computeSessionStats(entries));
  const totalCost = $derived(
    (stats.cost.input || 0) +
      (stats.cost.output || 0) +
      (stats.cost.cacheRead || 0) +
      (stats.cost.cacheWrite || 0),
  );
  const totalTokens = $derived(
    (stats.tokens.input || 0) +
      (stats.tokens.output || 0) +
      (stats.tokens.cacheRead || 0) +
      (stats.tokens.cacheWrite || 0),
  );
  const tokenRows = $derived(
    [
      { label: 'Input', value: stats.tokens.input || 0 },
      { label: 'Output', value: stats.tokens.output || 0 },
      { label: 'Cache read', value: stats.tokens.cacheRead || 0 },
      { label: 'Cache write', value: stats.tokens.cacheWrite || 0 },
    ].filter((r) => r.value > 0),
  );
  const modelBreakdown = $derived(computeModelBreakdown(entries));
  const messageCount = $derived(entries.filter((e) => e.type === 'message').length);
</script>

<FullScreenSheet
  bind:open
  title="Usage"
  backdropClass="mu-sheet-backdrop"
  panelClass="mu-sheet-panel"
  bodyClass="mu-sheet-body"
>
  <div class="mu-section">
    <div class="mu-label">Total cost</div>
    <div class="mu-cost">{formatCost(totalCost)}</div>
  </div>

  {#if tokenRows.length > 0}
    <div class="mu-card">
      <div class="mu-card-title">Tokens</div>
      {#each tokenRows as r (r.label)}
        <div class="mu-token-row">
          <span class="mu-token-name">{r.label}</span>
          <div class="mu-token-bar-wrap">
            <div
              class="mu-token-bar"
              style="width: {Math.max(3, (r.value / (totalTokens || 1)) * 100)}%;"
            ></div>
          </div>
          <span class="mu-token-value">{formatTokens(r.value)}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#if modelBreakdown.length > 0}
    <div class="mu-card">
      <div class="mu-card-title">Models</div>
      {#each modelBreakdown as m, i (m.name)}
        <div class="mu-model-block">
          <div class="mu-model-header">
            <span
              class="mu-model-dot"
              style="background:{MODEL_DOT_COLORS[i % MODEL_DOT_COLORS.length]}"
            ></span>
            <span class="mu-model-name" title={m.name}>{prettifyModelName(m.name)}</span>
            <span class="mu-model-pct">{Math.round(m.percent)}%</span>
          </div>
          <div class="mu-model-bar-wrap">
            <div
              class="mu-model-bar"
              style="width:{Math.max(2, m.percent)}%; background:{MODEL_DOT_COLORS[
                i % MODEL_DOT_COLORS.length
              ]}"
            ></div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="mu-card">
    <div class="mu-stat-row">
      <span class="mu-stat-label">Tool calls</span><span class="mu-stat-value"
        >{stats.toolCalls || 0}</span
      >
    </div>
    <div class="mu-stat-row">
      <span class="mu-stat-label">Models</span><span class="mu-stat-value"
        >{stats.models.length}</span
      >
    </div>
    <div class="mu-stat-row">
      <span class="mu-stat-label">Messages</span><span class="mu-stat-value">{messageCount}</span>
    </div>
  </div>
</FullScreenSheet>
