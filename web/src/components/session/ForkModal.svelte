<script module lang="ts">
  interface ForkEntry {
    readonly id?: string;
    readonly type?: string;
    readonly message?: unknown;
  }

  export interface UserMessageItem {
    readonly entryId: string;
    readonly text: string;
    readonly number: number;
  }
  // Pure helpers shared with SessionPage's open-bridge (for the empty check).
  export function normalizeText(text: unknown): string {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function truncateText(text: unknown, maxLength = 96): string {
    const n = normalizeText(text);
    if (!n) return '(empty)';
    return n.length <= maxLength ? n : n.slice(0, maxLength).trimEnd() + '…';
  }

  function extractUserMessageText(entry: ForkEntry): string {
    if (entry?.type !== 'message') return '';
    const msg = entry.message;
    if (typeof msg !== 'object' || msg === null || Reflect.get(msg, 'role') !== 'user') return '';
    const content = Reflect.get(msg, 'content');
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (b): b is { readonly type: 'text'; readonly text?: unknown } =>
            typeof b === 'object' && b !== null && 'type' in b && b.type === 'text',
        )
        .map((b) => String(b.text ?? ''))
        .join(' ');
    }
    return '';
  }

  // Latest user messages first; `number` is the 1-based position in send order.
  export function buildUserMessageList(entries: readonly ForkEntry[] = []): UserMessageItem[] {
    const messages: UserMessageItem[] = [];
    for (const entry of entries) {
      const text = normalizeText(extractUserMessageText(entry));
      if (text && entry.id) messages.push({ entryId: entry.id, text, number: messages.length + 1 });
    }
    return messages.reverse();
  }
</script>

<script lang="ts">
  // Fork palette — Svelte port of live/fork-modal.js. Lists the session's user
  // messages so one can be picked to fork from; search + keyboard nav + preview.
  // Opened via the bindable `open` prop; `entries` are passed fresh (the caller
  // fetches them) and `onSelect(entryId)` performs the fork.
  import FullScreenSheet from './FullScreenSheet.svelte';

  let {
    open = $bindable(false),
    entries = [],
    onSelect = null,
  }: {
    open?: boolean;
    entries?: readonly ForkEntry[];
    onSelect?: ((entryId: string) => void) | null;
  } = $props();

  let query = $state('');
  let selectedIndex = $state(0);
  let listEl = $state<HTMLDivElement | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);

  const userMessages = $derived(buildUserMessageList(entries));
  const filtered = $derived.by(() => {
    const q = normalizeText(query).toLowerCase();
    if (!q) return userMessages;
    return userMessages.filter(
      (m) => m.text.toLowerCase().includes(q) || String(m.number).includes(q.replace(/^#/, '')),
    );
  });
  const selected = $derived(
    filtered.length ? filtered[Math.min(selectedIndex, filtered.length - 1)] : null,
  );

  function move(delta: number, focus: boolean): void {
    if (filtered.length === 0) return;
    selectedIndex = Math.max(0, Math.min(selectedIndex + delta, filtered.length - 1));
    const el = listEl?.querySelector<HTMLButtonElement>(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
    if (focus) el?.focus?.();
  }

  function choose(msg: UserMessageItem | null | undefined): void {
    if (!msg) return;
    open = false;
    onSelect?.(msg.entryId);
  }

  function navKey(e: KeyboardEvent, focus: boolean): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1, focus);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1, focus);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(filtered[selectedIndex]);
    }
  }

  // Reset the highlight whenever the query changes.
  $effect(() => {
    void query;
    selectedIndex = 0;
  });

  // Focus the search box shortly after open (parity with the old rAF focus).
  $effect(() => {
    if (open && searchEl) {
      const id = setTimeout(() => searchEl?.focus(), 50);
      return () => clearTimeout(id);
    }
  });
</script>

<FullScreenSheet
  bind:open
  title="Fork from message"
  showClose={false}
  backdropClass="fork-sheet-backdrop"
  panelClass="fork-sheet-panel"
  bodyClass="fork-sheet-body"
>
  <div class="fork-palette">
    <div class="fork-search-wrap">
      <input
        class="fork-search-input"
        type="search"
        bind:value={query}
        bind:this={searchEl}
        onkeydown={(e) => navKey(e, false)}
        placeholder="Search messages..."
        autocomplete="off"
        spellcheck="false"
        aria-label="Search messages to fork from"
      />
    </div>
    <div class="fork-palette-content">
      <div
        class="fork-message-list"
        role="listbox"
        aria-label="Messages"
        tabindex="-1"
        bind:this={listEl}
        onkeydown={(e) => navKey(e, true)}
      >
        {#if filtered.length === 0}
          <div class="fork-empty-state">No matching messages</div>
        {:else}
          {#each filtered as msg, i (msg.entryId)}
            <button
              class="fork-message-item"
              class:is-selected={i === selectedIndex}
              type="button"
              role="option"
              data-idx={i}
              aria-selected={i === selectedIndex}
              onmouseenter={() => (selectedIndex = i)}
              onfocus={() => (selectedIndex = i)}
              onclick={() => choose(msg)}
            >
              <span class="fork-message-text">{truncateText(msg.text)}</span>
              <span class="fork-message-number">#{msg.number}</span>
            </button>
          {/each}
        {/if}
      </div>
      <aside class="fork-message-preview" aria-live="polite">
        {#if selected}
          <div class="fork-preview-meta">#{selected.number}</div>
          <div class="fork-preview-title">{truncateText(selected.text, 80)}</div>
          <div class="fork-preview-body">{selected.text}</div>
        {:else}
          <div class="fork-empty-state">No matching messages</div>
        {/if}
      </aside>
    </div>
    <div class="fork-palette-footer">↑↓ navigate • enter select • esc close</div>
  </div>
</FullScreenSheet>
