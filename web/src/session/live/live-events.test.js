import { describe, expect, it, vi } from 'vitest';
import {
  createSessionEventSource,
  getReloadEntryCount,
  getSessionIdFromLocation,
  handleSessionReload,
  wireSessionEvents,
} from './live-events.js';

describe('live events', () => {
  it('gets session id and creates event source', () => {
    expect(getSessionIdFromLocation({ locationImpl: { search: '?id=a%20b&x=1' } })).toBe('a%20b');
    const EventSourceImpl = vi.fn();
    createSessionEventSource('a b', { EventSourceImpl });
    expect(EventSourceImpl).toHaveBeenCalledWith('/events?id=a%20b');
  });

  it('disables count deltas for replaceable Codex projections', () => {
    expect(getReloadEntryCount({ header: { runtime: 'pi' }, entries: [{ id: 'a' }] })).toBe(1);
    expect(
      getReloadEntryCount({ header: { runtime: 'codex' }, entries: [{ id: 'a' }] }),
    ).toBeNull();
    expect(
      getReloadEntryCount({ header: { runtime: 'pi' }, entries: [], truncated: true }),
    ).toBeNull();
  });

  it('waits for reactive rendering before clearing the streaming preview', async () => {
    const order = [];
    await handleSessionReload({
      sessionId: 's',
      fetchImpl: vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ entries: [] }), { status: 200 })),
      ),
      entryState: { seen: new Set(), liveRendered: new Set() },
      onReloaded: async () => {
        order.push('reconcile');
        await Promise.resolve();
        order.push('rendered');
      },
      clearChatPreview: () => order.push('clear'),
    });
    expect(order).toEqual(['reconcile', 'rendered', 'clear']);
  });

  it('discards an older reload response that resolves after a newer generation', async () => {
    let resolveOld;
    let resolveNew;
    const oldResponse = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const newResponse = new Promise((resolve) => {
      resolveNew = resolve;
    });
    let latestGeneration = 1;
    const applied = [];
    const cleared = [];
    const base = {
      sessionId: 's',
      entryState: { seen: new Set(), liveRendered: new Set() },
      onReloaded: (data) => applied.push(data.name),
      clearChatPreview: () => cleared.push(true),
    };
    const oldReload = handleSessionReload({
      ...base,
      fetchImpl: () => oldResponse,
      shouldApply: () => latestGeneration === 1,
    });
    latestGeneration = 2;
    const newReload = handleSessionReload({
      ...base,
      fetchImpl: () => newResponse,
      shouldApply: () => latestGeneration === 2,
    });

    resolveNew(new Response(JSON.stringify({ name: 'new', entries: [] }), { status: 200 }));
    await newReload;
    resolveOld(new Response(JSON.stringify({ name: 'old', entries: [] }), { status: 200 }));
    const oldResult = await oldReload;

    expect(applied).toEqual(['new']);
    expect(cleared).toHaveLength(1);
    expect(oldResult.stale).toBe(true);
  });

  it('handles reload entries, title, and follow behavior', async () => {
    const entries = [{ id: 'a' }, { id: 'r', message: { role: 'toolResult' } }];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ name: 'New Title', entries }), { status: 200 }),
      ),
    );
    const entryState = { seen: new Set(), liveRendered: new Set() };
    const appendEntry = vi.fn((entry) => {
      entryState.seen.add(entry.id);
      return true;
    });
    const refresh = vi.fn();
    const updateStats = vi.fn();
    const updateTitle = vi.fn();
    const scrollAfterLayout = vi.fn();
    const onReloaded = vi.fn();

    const result = await handleSessionReload({
      sessionId: 's',
      fetchImpl,
      entryState,
      clearChatPreview: vi.fn(),
      appendEntry,
      upsertEntry: vi.fn(),
      refreshEntriesAffectedByToolResult: refresh,
      updateStats,
      updateTitle,
      isFollowing: () => true,
      scrollAfterLayout,
      onReloaded,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/session?id=s');
    expect(result.newCount).toBe(2);
    expect(onReloaded).toHaveBeenCalledWith({ name: 'New Title', entries, isDelta: false });
    expect(refresh).toHaveBeenCalledWith(entries[1], entries);
    expect(updateStats).toHaveBeenCalledWith(entries);
    expect(updateTitle).toHaveBeenCalledWith('New Title');
    expect(scrollAfterLayout).toHaveBeenCalledWith(true);
  });

  it('reconciles via the model in reactive mode (no DOM patching)', async () => {
    // No appendEntry/upsertEntry → the Svelte <SessionContent> owns #messages.
    // handleSessionReload only tracks new ids and flags them via onNewEntries.
    const entries = [{ id: 'a' }, { id: 'b' }];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ entries }), { status: 200 })),
    );
    const entryState = { seen: new Set(['a']), liveRendered: new Set() };
    const onReloaded = vi.fn();
    const onNewEntries = vi.fn();
    const scrollAfterLayout = vi.fn();
    const clearChatPreview = vi.fn();

    const result = await handleSessionReload({
      sessionId: 's',
      fetchImpl,
      entryState,
      clearChatPreview,
      isFollowing: () => true,
      scrollAfterLayout,
      onReloaded,
      onNewEntries,
    });

    expect(onReloaded).toHaveBeenCalledWith({ entries, isDelta: false });
    expect(result.newCount).toBe(1);
    expect(entryState.seen.has('b')).toBe(true);
    expect(onNewEntries).toHaveBeenCalledWith(['b']);
    expect(clearChatPreview).toHaveBeenCalled();
    expect(scrollAfterLayout).toHaveBeenCalledWith(true);
  });

  it('requests a delta with afterCount and flags isDelta when the server confirms deltaOk', async () => {
    const deltaEntries = [{ id: 'c' }, { id: 'd' }];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ entries: deltaEntries, deltaOk: true, from: 2, total: 4 }), {
          status: 200,
        }),
      ),
    );
    const entryState = { seen: new Set(['a', 'b']), liveRendered: new Set() };
    const onReloaded = vi.fn();
    const getEntryCount = vi.fn(() => 2);

    const result = await handleSessionReload({
      sessionId: 's',
      fetchImpl,
      entryState,
      clearChatPreview: vi.fn(),
      isFollowing: () => true,
      scrollAfterLayout: vi.fn(),
      onReloaded,
      getEntryCount,
    });

    expect(getEntryCount).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith('/api/session?id=s&afterCount=2');
    expect(onReloaded).toHaveBeenCalledWith({
      entries: deltaEntries,
      deltaOk: true,
      from: 2,
      total: 4,
      isDelta: true,
    });
    // The new-id detection loop still works correctly on a delta-only tail:
    // both ids in the delta are genuinely new against entryState.seen.
    expect(result.newCount).toBe(2);
  });

  it('falls back to a full resync (isDelta: false) when the server reports deltaOk: false', async () => {
    const fullEntries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ entries: fullEntries, deltaOk: false, from: 0, total: 3 }), {
          status: 200,
        }),
      ),
    );
    const entryState = { seen: new Set(['a']), liveRendered: new Set() };
    const onReloaded = vi.fn();
    // Client thinks it has 99 entries (stale/out-of-sync count) — the server
    // rejects the delta and self-heals with the full list instead.
    const getEntryCount = vi.fn(() => 99);

    await handleSessionReload({
      sessionId: 's',
      fetchImpl,
      entryState,
      clearChatPreview: vi.fn(),
      isFollowing: () => true,
      scrollAfterLayout: vi.fn(),
      onReloaded,
      getEntryCount,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/session?id=s&afterCount=99');
    expect(onReloaded).toHaveBeenCalledWith({
      entries: fullEntries,
      deltaOk: false,
      from: 0,
      total: 3,
      isDelta: false,
    });
  });

  it('does not append afterCount when getEntryCount returns null (e.g. a truncated/paginated session)', async () => {
    const entries = [{ id: 'a' }];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ entries }), { status: 200 })),
    );
    const entryState = { seen: new Set(), liveRendered: new Set() };

    await handleSessionReload({
      sessionId: 's',
      fetchImpl,
      entryState,
      clearChatPreview: vi.fn(),
      onReloaded: vi.fn(),
      getEntryCount: () => null,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/session?id=s');
  });

  it('scrolls instead of showing the button when at the bottom but follow flag is stale', async () => {
    // Regression: agent finishes while the viewport is pinned to the bottom, but
    // `following` was knocked false by a relayout clamp. The reload must use the
    // live scroll position and not pop the "scroll to bottom" button.
    const entries = [{ id: 'a' }, { id: 'b' }];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ entries }), { status: 200 })),
    );
    const entryState = { seen: new Set(['a']), liveRendered: new Set() };
    const scrollAfterLayout = vi.fn();
    const incrementPending = vi.fn();
    const showFollowButton = vi.fn();

    await handleSessionReload({
      sessionId: 's',
      fetchImpl,
      entryState,
      clearChatPreview: vi.fn(),
      isFollowing: () => false,
      isAtBottom: () => true,
      scrollAfterLayout,
      incrementPending,
      showFollowButton,
      onReloaded: vi.fn(),
    });

    expect(scrollAfterLayout).toHaveBeenCalledWith(true);
    expect(showFollowButton).not.toHaveBeenCalled();
    expect(incrementPending).not.toHaveBeenCalled();
  });

  it('shows the button when not following and not at the bottom', async () => {
    const entries = [{ id: 'a' }, { id: 'b' }];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ entries }), { status: 200 })),
    );
    const entryState = { seen: new Set(['a']), liveRendered: new Set() };
    const scrollAfterLayout = vi.fn();
    const incrementPending = vi.fn();
    const showFollowButton = vi.fn();

    await handleSessionReload({
      sessionId: 's',
      fetchImpl,
      entryState,
      clearChatPreview: vi.fn(),
      isFollowing: () => false,
      isAtBottom: () => false,
      scrollAfterLayout,
      incrementPending,
      showFollowButton,
      onReloaded: vi.fn(),
    });

    expect(showFollowButton).toHaveBeenCalledTimes(1);
    expect(incrementPending).toHaveBeenCalledWith(1);
    expect(scrollAfterLayout).not.toHaveBeenCalled();
  });

  it('wires event source messages', () => {
    const eventSource = { addEventListener: vi.fn() };
    const onReload = vi.fn();
    const onChatPreview = vi.fn();
    const onError = vi.fn();
    wireSessionEvents({ eventSource, onReload, onChatPreview, onError });
    eventSource.onmessage({ data: 'noop' });
    eventSource.onmessage({ data: 'reload' });
    expect(onReload).toHaveBeenCalledTimes(1);
    const previewHandler = eventSource.addEventListener.mock.calls[0][1];
    previewHandler({ data: JSON.stringify({ content: 'x' }) });
    expect(onChatPreview).toHaveBeenCalledWith({ content: 'x' });
    previewHandler({ data: '{bad' });
    expect(onError).toHaveBeenCalled();
  });

  it('reconciles on a chat-preview done (covers a dropped first-write reload)', () => {
    const eventSource = { addEventListener: vi.fn() };
    const onReload = vi.fn();
    const onChatPreview = vi.fn();
    wireSessionEvents({ eventSource, onReload, onChatPreview });
    const previewHandler = eventSource.addEventListener.mock.calls[0][1];

    previewHandler({ data: JSON.stringify({ content: 'streaming', done: false }) });
    expect(onReload).not.toHaveBeenCalled();

    previewHandler({ data: JSON.stringify({ content: 'final', done: true }) });
    expect(onChatPreview).toHaveBeenLastCalledWith({ content: 'final', done: true });
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('dispatches pi-session-reload window event on reload', () => {
    const eventSource = { addEventListener: vi.fn() };
    const dispatched = [];
    const windowImpl = {
      dispatchEvent: (e) => {
        dispatched.push(e);
        return true;
      },
    };
    class FakeCustomEvent {
      constructor(type) {
        this.type = type;
      }
    }
    wireSessionEvents({
      eventSource,
      onReload: vi.fn(),
      onChatPreview: vi.fn(),
      windowImpl,
      CustomEventImpl: FakeCustomEvent,
    });
    eventSource.onmessage({ data: 'reload' });
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe('pi-session-reload');
    eventSource.onmessage({ data: 'noop' });
    expect(dispatched.length).toBe(1);
  });

  it('dispatches extension UI events with parsed payloads', () => {
    const handlers = new Map();
    const eventSource = {
      addEventListener: vi.fn((name, handler) => handlers.set(name, handler)),
    };
    const dispatched = [];
    class FakeCustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    }
    wireSessionEvents({
      eventSource,
      onReload: vi.fn(),
      onChatPreview: vi.fn(),
      windowImpl: { dispatchEvent: (event) => dispatched.push(event) },
      CustomEventImpl: FakeCustomEvent,
    });

    handlers.get('extension-ui-request')({ data: '{"id":"ui-1","method":"confirm"}' });
    handlers.get('extension-ui-resolved')({ data: '{"id":"ui-1"}' });
    handlers.get('extension-notify')({ data: '{"message":"Done","type":"info"}' });

    expect(dispatched.map((event) => event.type)).toEqual([
      'pi-extension-ui-request',
      'pi-extension-ui-resolved',
      'pi-extension-notify',
    ]);
    expect(dispatched[0].detail.id).toBe('ui-1');
  });
});
