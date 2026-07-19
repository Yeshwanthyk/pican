<script lang="ts">
  import { Schema } from 'effect';
  import * as Http from '../../lib/http.js';
  import type { FetchLike } from '../../lib/http.js';
  import { describeError } from '../../lib/errors.js';
  import { runPromise } from '../../lib/runtime.js';
  import { sessionEntryFromUnknown, type SessionEntry } from '../../session/data/session-types.js';
  import type { NavigateTo } from '../../session/session-runtime-context.js';
  import { t } from '../../shared/strings.js';

  interface EarlierModel {
    entries: SessionEntry[];
    total: number;
    from: number;
    truncated: boolean;
    leafId: string;
    reconcile?: (entries: SessionEntry[]) => void;
  }

  interface Props {
    model: EarlierModel;
    sessionId?: string;
    fetchImpl?: FetchLike | null;
    navigateTo?: NavigateTo | null;
    windowSize?: number;
  }

  const EarlierResponse = Schema.Struct({ entries: Schema.optional(Schema.Array(Schema.Unknown)) });

  let {
    model,
    sessionId = '',
    fetchImpl = null,
    navigateTo = null,
    windowSize = 500,
  }: Props = $props();

  let loading = $state(false);
  let error = $state('');

  const shown = $derived(model?.entries?.length || 0);
  const total = $derived(model?.total || shown);
  const remaining = $derived(Math.max(0, model?.from || 0));
  const nextCount = $derived(Math.min(windowSize, remaining));
  const visible = $derived(!!model && !!model.truncated && remaining > 0);
  const effectiveFetch = $derived(
    fetchImpl || (typeof window !== 'undefined' ? window.fetch.bind(window) : null),
  );

  function loadEarlier(): void {
    if (loading || !visible || !effectiveFetch) return;
    const requestFrom = Math.max(0, model.from - windowSize);
    const requestCount = model.from - requestFrom;
    const anchorId = model.entries[0]?.id || null;
    loading = true;
    error = '';
    const url = `/api/session?id=${encodeURIComponent(sessionId)}&from=${requestFrom}&count=${requestCount}`;
    void runPromise(Http.get(url, EarlierResponse, { fetchImpl: effectiveFetch })).then(
      (payload) => {
        const earlier = (payload.entries ?? []).flatMap((entry) => {
          const parsed = sessionEntryFromUnknown(entry);
          return parsed ? [parsed] : [];
        });
        if (earlier.length === 0) {
          model.from = 0;
          model.truncated = false;
          loading = false;
          return;
        }
        model.reconcile?.([...earlier, ...model.entries]);
        navigateTo?.(model.leafId, anchorId ? 'target' : 'bottom', anchorId || null);
        model.from = requestFrom;
        model.truncated = requestFrom > 0;
        loading = false;
      },
      (failure: unknown) => {
        error = describeError(failure);
        loading = false;
      },
    );
  }
</script>

{#if visible}
  <div
    id="load-earlier-banner"
    class="load-earlier-banner"
    role="region"
    aria-label={t('session.earlierMessages')}
  >
    <span class="load-earlier-label"
      >{t('session.showingLatestMessages', {
        shown: shown.toLocaleString(),
        total: total.toLocaleString(),
      })}</span
    >
    <button
      type="button"
      class="load-earlier-button"
      disabled={loading || remaining <= 0}
      onclick={loadEarlier}
    >
      {#if loading}{t('session.loadingEarlier')}{:else}{t('session.loadEarlierCount', {
          count: nextCount.toLocaleString(),
        })}{/if}
    </button>
    <span class="load-earlier-status"
      >{#if error}{t('session.loadEarlierFailed', { error })}{/if}</span
    >
  </div>
{/if}
