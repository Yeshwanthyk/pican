import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { reconnectDelay, setupSessionLiveConnection } from './live-connection.js';

function setupDom() {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost/session?id=s1' });
  Object.defineProperty(dom.window.document, 'hidden', {
    configurable: true,
    value: false,
  });
  return dom;
}

describe('live connection', () => {
  it('computes capped reconnect delays with jitter', () => {
    expect(reconnectDelay(0, { randomImpl: () => 0 })).toBe(1000);
    expect(reconnectDelay(1, { randomImpl: () => 0.25 })).toBe(2125);
    expect(reconnectDelay(10, { randomImpl: () => 0.998 })).toBe(30499);
  });

  it('connects, wires events, and closes the previous EventSource on reconnect', () => {
    const dom = setupDom();
    const first = { close: vi.fn(), readyState: 1 };
    const second = { close: vi.fn(), readyState: 1 };
    const createEventSource = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const wireEvents = vi.fn();

    const connection = setupSessionLiveConnection({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      sessionId: 's1',
      createEventSource,
      wireEvents,
    });

    expect(connection.connect()).toBe(first);
    expect(connection.connect()).toBe(second);
    expect(first.close).toHaveBeenCalled();
    expect(createEventSource).toHaveBeenCalledWith('s1', {
      EventSourceImpl: dom.window.EventSource,
    });
    expect(wireEvents).toHaveBeenCalledTimes(2);

    connection.dispose();
    expect(second.close).toHaveBeenCalled();
  });

  it('schedules manual reconnect only when EventSource is closed', () => {
    const dom = setupDom();
    const timers = [];
    const eventSource = { close: vi.fn(), readyState: 2 };
    const replacement = { close: vi.fn(), readyState: 1 };
    const createEventSource = vi
      .fn()
      .mockReturnValueOnce(eventSource)
      .mockReturnValueOnce(replacement);
    const onReload = vi.fn();
    const wireEvents = vi.fn(({ onError }) => {
      eventSource.onError = onError;
    });

    const connection = setupSessionLiveConnection({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      sessionId: 's1',
      createEventSource,
      wireEvents,
      onReload,
      setTimeoutImpl: (cb, delay) => {
        timers.push({ cb, delay });
        return timers.length;
      },
      clearTimeoutImpl: vi.fn(),
      randomImpl: () => 0,
    });
    connection.connect();
    eventSource.onError(new Error('closed'));

    expect(timers).toHaveLength(1);
    expect(timers[0].delay).toBe(1000);
    timers[0].cb();

    expect(createEventSource).toHaveBeenCalledTimes(2);
    expect(onReload).toHaveBeenCalledTimes(1);
    connection.dispose();
  });

  it('reloads on visibilitychange and reconnects when the source is closed', () => {
    const dom = setupDom();
    const active = { close: vi.fn(), readyState: 1 };
    const closed = { close: vi.fn(), readyState: 2 };
    const replacement = { close: vi.fn(), readyState: 1 };
    const createEventSource = vi
      .fn()
      .mockReturnValueOnce(active)
      .mockReturnValueOnce(closed)
      .mockReturnValueOnce(replacement);
    const onReload = vi.fn();

    const connection = setupSessionLiveConnection({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      sessionId: 's1',
      createEventSource,
      wireEvents: vi.fn(),
      onReload,
    });
    connection.connect();
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(createEventSource).toHaveBeenCalledTimes(1);

    connection.connect();
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(createEventSource).toHaveBeenCalledTimes(3);
    expect(closed.close).toHaveBeenCalled();

    connection.dispose();
  });

  it('reconnects and reloads when the browser comes online', () => {
    const dom = setupDom();
    const first = { close: vi.fn(), readyState: 1 };
    const second = { close: vi.fn(), readyState: 1 };
    const createEventSource = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const onReload = vi.fn();

    const connection = setupSessionLiveConnection({
      documentImpl: dom.window.document,
      windowImpl: dom.window,
      sessionId: 's1',
      createEventSource,
      wireEvents: vi.fn(),
      onReload,
    });
    connection.connect();
    dom.window.dispatchEvent(new dom.window.Event('online'));

    expect(createEventSource).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalled();
    expect(onReload).toHaveBeenCalledTimes(1);
    connection.dispose();
  });
});
