<script lang="ts">
  // Reusable full-screen sheet: a centered dialog on desktop, a fullscreen
  // bottom-sheet on mobile (≤ 900px). Svelte port of the former
  // live/full-screen-sheet.js (showSheet) — same markup/classes/behavior:
  // scroll-lock (ref-counted), focus trap, Escape/backdrop close, and a
  // synthetic history entry on mobile so the back gesture closes the sheet.
  //
  // Driven by a single bindable `open`; internal triggers (Escape, backdrop,
  // back/close buttons, mobile popstate) set `open = false` and an $effect runs
  // the open/close side effects. Body content is provided as the default snippet.
  import { Effect } from 'effect';
  import { onMount, tick, type Snippet } from 'svelte';
  import { runSync } from '../../lib/runtime.js';
  import { icon, ArrowLeft, X } from '../../shared/icons.js';
  import { t } from '../../shared/strings.js';

  interface Props {
    open?: boolean;
    title?: string;
    showBack?: boolean;
    showClose?: boolean;
    closeOnEscape?: boolean;
    closeOnBackdrop?: boolean;
    onClose?: (() => void) | null;
    backdropClass?: string;
    panelClass?: string;
    bodyClass?: string;
    children: Snippet;
    headerExtra?: Snippet | null;
  }

  let {
    open = $bindable(false),
    title = '',
    showBack = true,
    showClose = true,
    closeOnEscape = true,
    closeOnBackdrop = true,
    onClose = null,
    // Per-modal styling hooks (the former showSheet consumers tagged the
    // backdrop/panel/body with their own classes for CSS).
    backdropClass = '',
    panelClass = '',
    bodyClass = '',
    children,
    // Optional inline controls rendered between the back button and the
    // close-X inside .pi-sheet-header. Lets a sheet host its primary actions
    // in the header bar instead of a second toolbar row underneath — useful
    // on mobile where vertical space is scarce.
    headerExtra = null,
  }: Props = $props();

  const SHEET_BREAKPOINT = 900;
  const REMOVE_DELAY = 300; // must match the CSS transition duration

  let mounted = $state(false); // DOM presence (stays true through the close anim)
  let shown = $state(false); // toggles the `.open` class for the CSS transition
  let mobile = $state(false);
  let backdropEl = $state<HTMLDivElement | null>(null);
  let panelEl = $state<HTMLDivElement | null>(null);

  let previousActive: HTMLElement | null = null;
  let removeTimer: ReturnType<typeof setTimeout> | undefined;
  let popHandler: (() => void) | null = null;
  let historyMarker = '';
  let skipHistoryOnce = false;

  // Backdrop click-to-close, attached imperatively (not inline onclick) to match
  // the codebase's delegated-listener convention and avoid an a11y lint on a
  // non-interactive element — Escape (onKey) is the keyboard equivalent.
  function onBackdrop(e: MouseEvent): void {
    if (closeOnBackdrop && e.target === backdropEl) open = false;
  }

  function isMobile(): boolean {
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia(`(max-width: ${SHEET_BREAKPOINT}px)`).matches
    );
  }

  let scrollLocked = false;

  // Ref-counted page-scroll lock so nested/stacked sheets don't unlock early.
  function lockScroll(): void {
    if (scrollLocked) return;
    scrollLocked = true;
    const body = document.body;
    const count = Number(body.dataset.piSheetCount || '0') + 1;
    body.dataset.piSheetCount = String(count);
    body.classList.add('pi-sheet-open');
  }
  function unlockScroll(): void {
    if (!scrollLocked) return;
    scrollLocked = false;
    const body = document.body;
    const count = Math.max(0, Number(body.dataset.piSheetCount || '0') - 1);
    if (count === 0) {
      delete body.dataset.piSheetCount;
      body.classList.remove('pi-sheet-open');
    } else {
      body.dataset.piSheetCount = String(count);
    }
  }

  function getFocusable(): HTMLElement[] {
    if (!panelEl) return [];
    return Array.from(
      panelEl.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }

  function onKey(e: KeyboardEvent): void {
    if (closeOnEscape && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      open = false;
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = panelEl;
    if (!panel) return;
    const focusables = getFocusable();
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (e.shiftKey) {
      if (document.activeElement === first || !panel.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last || !panel.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  function ignoreFailure(action: () => void): void {
    runSync(
      Effect.try({ try: action, catch: () => undefined }).pipe(
        Effect.orElseSucceed(() => undefined),
      ),
    );
  }

  async function doOpen(): Promise<void> {
    mounted = true;
    shown = false;
    mobile = isMobile();
    previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lockScroll();
    document.addEventListener('keydown', onKey);

    if (mobile && window.history && typeof window.history.pushState === 'function') {
      historyMarker = `pi-sheet:${Math.random().toString(36).slice(2, 8)}`;
      const cur =
        window.history.state && typeof window.history.state === 'object'
          ? window.history.state
          : {};
      ignoreFailure(() => {
        window.history.pushState({ ...cur, __piSheet: historyMarker }, '', window.location?.href);
      });
      popHandler = () => {
        skipHistoryOnce = true;
        open = false;
      };
      window.addEventListener('popstate', popHandler);
    }

    await tick();
    backdropEl?.addEventListener('click', onBackdrop);
    requestAnimationFrame(() => {
      shown = true;
      // Focus the panel itself (tabindex=-1, outline:none) rather than the
      // first focusable control. Focusing a button shows :focus-visible after
      // any keyboard-mode trigger (e.g. opening via URL after Cmd-R refresh),
      // which surfaces a stray focus ring on the back arrow. The focus trap
      // still works — Tab moves into the contained focusables.
      panelEl?.focus();
    });
  }

  function doClose(): void {
    backdropEl?.removeEventListener('click', onBackdrop);
    document.removeEventListener('keydown', onKey);
    if (popHandler) {
      window.removeEventListener('popstate', popHandler);
      if (!skipHistoryOnce && window.history?.state?.__piSheet === historyMarker) {
        ignoreFailure(() => window.history.back());
      }
      popHandler = null;
    }
    skipHistoryOnce = false;
    unlockScroll();
    shown = false;
    clearTimeout(removeTimer);
    removeTimer = setTimeout(() => {
      mounted = false;
      if (previousActive && typeof previousActive.focus === 'function') previousActive.focus();
    }, REMOVE_DELAY);
    if (onClose) onClose();
  }

  // Single source of truth: the bindable `open` drives mount + teardown.
  $effect(() => {
    if (open && !mounted) doOpen();
    else if (!open && mounted) doClose();
  });

  // Release any global listeners / scroll-lock / pending timer if the component
  // is destroyed while still open (e.g. SPA route change).
  onMount(() => () => {
    document.removeEventListener('keydown', onKey);
    backdropEl?.removeEventListener('click', onBackdrop);
    if (popHandler) window.removeEventListener('popstate', popHandler);
    clearTimeout(removeTimer);
    unlockScroll();
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted: Lucide icon SVG and rendered session markdown -->

{#if mounted}
  <div
    class="pi-sheet-backdrop {backdropClass}"
    class:pi-sheet-mobile={mobile}
    class:open={shown}
    bind:this={backdropEl}
  >
    <div
      class="pi-sheet-panel {panelClass}"
      class:pi-sheet-mobile={mobile}
      class:open={shown}
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
    >
      <h2 class="sr-only">{title}</h2>
      <div class="pi-sheet-header">
        {#if showBack}
          <button
            class="pi-sheet-back"
            aria-label={t('common.closeNamed', { name: title })}
            onclick={() => (open = false)}
          >
            <span aria-hidden="true">{@html icon(ArrowLeft, { size: 16 })}</span><span>{title}</span
            >
          </button>
        {:else}
          <div></div>
        {/if}
        {#if headerExtra}
          <div class="pi-sheet-header-extra">{@render headerExtra()}</div>
        {/if}
        {#if showClose}
          <button
            class="pi-sheet-close-x"
            aria-label={t('common.close')}
            onclick={() => (open = false)}>{@html icon(X, { size: 16 })}</button
          >
        {/if}
      </div>
      <div class="pi-sheet-body {bodyClass}">{@render children?.()}</div>
    </div>
  </div>
{/if}
