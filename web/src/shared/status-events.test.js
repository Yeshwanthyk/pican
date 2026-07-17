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

    const sub = createStatusEvents({
      EventSourceImpl: FakeEventSource,
      onSnapshot,
      onDelta,
      onMessage,
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
});
