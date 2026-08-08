<script lang="ts">
  import { tick } from 'svelte';
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

  function captureAnchor(
    fallbackId: string | null,
  ): { readonly id: string; readonly top: number } | null {
    if (typeof document === 'undefined') return null;
    const list = document.getElementById('messages-list');
    const rendered =
      list?.querySelector<HTMLElement>(
        ':scope > .transcript-render-item > .user-message[id^="entry-"]',
      ) ??
      list?.querySelector<HTMLElement>('[id^="entry-"]') ??
      null;
    const fallback = fallbackId ? document.getElementById(`entry-${fallbackId}`) : null;
    const element = rendered ?? fallback;
    const id = element?.id.replace(/^entry-/, '') ?? '';
    return element instanceof HTMLElement && id
      ? { id, top: element.getBoundingClientRect().top }
      : null;
  }

  function restoreAnchor(
    anchorId: string,
    expectedSessionId: string,
    previousTop: number,
    framesRemaining = 12,
  ): void {
    const list = document.getElementById('messages-list');
    if (list?.dataset.sessionId !== expectedSessionId) return;
    const element = document.getElementById(`entry-${anchorId}`);
    if (!(element instanceof HTMLElement) || !list.contains(element)) {
      // Reconciliation can briefly replace an entry while a new activity group
      // is projected. Retry only while the same session container still owns
      // this restore, so a quick session switch cannot move another transcript.
      if (framesRemaining > 1) {
        requestAnimationFrame(() =>
          restoreAnchor(anchorId, expectedSessionId, previousTop, framesRemaining - 1),
        );
      }
      return;
    }
    const delta = element.getBoundingClientRect().top - previousTop;
    if (Math.abs(delta) > 0.5) {
      const content = document.getElementById('content');
      if (content && content.scrollHeight > content.clientHeight) {
        element.scrollIntoView({ block: 'start', behavior: 'instant' });
        content.scrollTop += element.getBoundingClientRect().top - previousTop;
      } else {
        window.scrollBy({ top: delta, behavior: 'auto' });
      }
    }
    // WebKit and deferred Markdown work may settle heights over subsequent
    // frames. Keep the same anchor stable through that short window.
    if (framesRemaining > 1) {
      requestAnimationFrame(() =>
        restoreAnchor(anchorId, expectedSessionId, previousTop, framesRemaining - 1),
      );
    }
  }

  function loadEarlier(): void {
    if (loading || !visible || !effectiveFetch) return;
    const requestFrom = Math.max(0, model.from - windowSize);
    const requestCount = model.from - requestFrom;
    const fallbackAnchorId = model.entries[0]?.id || null;
    const anchor = captureAnchor(fallbackAnchorId);
    const anchorId = anchor?.id ?? fallbackAnchorId;
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
          if (anchorId && anchor) {
            void tick().then(() => restoreAnchor(anchorId, sessionId, anchor.top));
          }
          return;
        }
        model.reconcile?.([...earlier, ...model.entries]);
        model.from = requestFrom;
        model.truncated = requestFrom > 0;
        loading = false;
        if (anchorId && anchor) {
          void tick().then(() => restoreAnchor(anchorId, sessionId, anchor.top));
        } else {
          navigateTo?.(model.leafId, anchorId ? 'target' : 'bottom', anchorId || null);
        }
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
