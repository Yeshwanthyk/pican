import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createStatusEvents } from './status-events.js';

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.listeners = {};
    this.close = vi.fn();
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, fn) {
    (this.listeners[name] ||= []).push(fn);
  }
  emit(name, data) {
    const event = { data };
    if (name === 'message') {
      this.onmessage?.(event);
      return;
    }
    for (const fn of this.listeners[name] || []) fn(event);
  }
}
FakeEventSource.instances = [];

describe('createStatusEvents', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  it('subscribes to all-session status events and exposes parsed callbacks', () => {
    const onSnapshot = vi.fn();
    const onDelta = vi.fn();
    const onMessage = vi.fn();
    const onWorkflowUpdate = vi.fn();
    const onTasksUpdate = vi.fn();

    const sub = createStatusEvents({
      EventSourceImpl: FakeEventSource,
      onSnapshot,
      onDelta,
      onMessage,
      onWorkflowUpdate,
      onTasksUpdate,
    });
    sub.connect();

    const es = FakeEventSource.instances[0];
    expect(es.url).toBe('/events?id=__all__');

    es.emit(
      'status-snapshot',
      JSON.stringify({
        running: ['a.jsonl'],
        statuses: { 'a.jsonl': { model: 'm', modelProvider: 'p' } },
      }),
    );
    es.emit(
      'status-delta',
      JSON.stringify({ id: 'a.jsonl', running: false, model: 'm', modelProvider: 'p' }),
    );
    es.emit('message', 'new-session');
    es.emit('workflows-updated', JSON.stringify({ runId: 'wf_123456abcdef' }));
    es.emit('tasks-updated', JSON.stringify({ project: '/repo' }));

    expect(onSnapshot).toHaveBeenCalledWith({
      ids: ['a.jsonl'],
      statuses: { 'a.jsonl': { model: 'm', modelProvider: 'p' } },
    });
    expect(onDelta).toHaveBeenCalledWith({
      id: 'a.jsonl',
      running: false,
      model: 'm',
      modelName: '',
      modelProvider: 'p',
    });
    expect(onMessage).toHaveBeenCalledWith('new-session');
    expect(onWorkflowUpdate).toHaveBeenCalledWith({ runId: 'wf_123456abcdef' });
    expect(onTasksUpdate).toHaveBeenCalledWith({ project: '/repo' });
  });

  it('ignores malformed payloads and invalid delta shapes', () => {
    const onSnapshot = vi.fn();
    const onDelta = vi.fn();
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, onSnapshot, onDelta });
    sub.connect();
    const es = FakeEventSource.instances[0];

    es.emit('status-snapshot', '{bad');
    es.emit('status-snapshot', JSON.stringify({ running: 'a.jsonl' }));
    es.emit('status-delta', JSON.stringify({ running: true }));

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onDelta).not.toHaveBeenCalled();
  });

  it('closes an existing stream before reconnecting and removes pagehide listener on cleanup', () => {
    const removeEventListener = vi.fn();
    const addEventListener = vi.fn();
    const sub = createStatusEvents({
      EventSourceImpl: FakeEventSource,
      windowImpl: { addEventListener, removeEventListener },
    });

    sub.connect();
    const first = FakeEventSource.instances[0];
    sub.connect();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function));

    sub.cleanup();
    expect(FakeEventSource.instances[1].close).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('pageshow', expect.any(Function));
  });

  it('does not fire onReconnect for the initial connection', () => {
    const onReconnect = vi.fn();
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, onReconnect });
    sub.connect();

    FakeEventSource.instances[0].emit('open');

    expect(onReconnect).not.toHaveBeenCalled();
  });

  // Regression test: the home page used to sit on a stale list after a
  // reconnect (network blip, or pageshow after the tab was backgrounded)
  // until an unrelated broadcast happened to arrive. onReconnect fires on
  // every 'open' after the first, whether the browser auto-reconnected the
  // existing EventSource or connect() was called again explicitly.
  it('fires onReconnect when the underlying EventSource reopens after the first connection', () => {
    const onReconnect = vi.fn();
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, onReconnect });
    sub.connect();
    const es = FakeEventSource.instances[0];

    es.emit('open'); // initial connect — no reconnect callback
    expect(onReconnect).not.toHaveBeenCalled();

    es.emit('open'); // browser auto-reconnected the same EventSource
    expect(onReconnect).toHaveBeenCalledTimes(1);

    es.emit('open'); // and again
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it('fires onReconnect after a pageshow-triggered reconnect', () => {
    const listeners = {};
    const windowImpl = {
      addEventListener: (name, fn) => {
        listeners[name] = fn;
      },
      removeEventListener: () => {},
    };
    const onReconnect = vi.fn();
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, windowImpl, onReconnect });
    sub.connect();
    FakeEventSource.instances[0].emit('open');
    expect(onReconnect).not.toHaveBeenCalled();

    // pagehide closes the stream (stream becomes null); pageshow reconnects.
    listeners.pagehide();
    listeners.pageshow();

    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1].emit('open');
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('routes reload broadcasts to onReload with the touched session id', () => {
    const onReload = vi.fn();
    const onMessage = vi.fn();
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, onReload, onMessage });
    sub.connect();
    const es = FakeEventSource.instances[0];

    es.emit('message', 'reload:abc_123.jsonl');
    expect(onReload).toHaveBeenCalledWith({ id: 'abc_123.jsonl' });

    // Bare "reload" (legacy/session-topic form) maps to an empty id so
    // callers fall back to an unconditional refresh.
    es.emit('message', 'reload');
    expect(onReload).toHaveBeenCalledWith({ id: '' });

    // Non-reload messages never reach onReload but still reach onMessage.
    es.emit('message', 'new-session');
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledWith('new-session');
  });
});
