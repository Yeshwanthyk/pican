import { describe, expect, it, vi } from 'vitest';
import {
  closeBtwEventSource,
  createBtwEventSource,
  setupBtwParentEvents,
  setupBtwSessionEvents,
} from './btw-events.js';

function fakeEventSourceClass(instances) {
  return class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.close = vi.fn();
      instances.push(this);
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    emit(type, data) {
      this.listeners.get(type)?.({ data });
    }
  };
}

describe('btw events', () => {
  it('creates encoded EventSource URLs', () => {
    const instances = [];
    const EventSourceImpl = fakeEventSourceClass(instances);
    const source = createBtwEventSource('parent session.jsonl', { EventSourceImpl });
    expect(source.url).toBe('/events?id=parent%20session.jsonl');
  });

  it('wires session reload and chat-preview events', () => {
    const instances = [];
    const EventSourceImpl = fakeEventSourceClass(instances);
    const onReload = vi.fn();
    const onChatPreview = vi.fn();
    const source = setupBtwSessionEvents({
      sessionId: 's1.jsonl',
      EventSourceImpl,
      onReload,
      onChatPreview,
    });

    source.onmessage({ data: 'noop' });
    source.onmessage({ data: 'reload' });
    expect(onReload).toHaveBeenCalledTimes(1);

    source.emit('chat-preview', JSON.stringify({ content: 'partial', done: false }));
    source.emit('chat-preview', '{bad');
    expect(onChatPreview).toHaveBeenCalledWith({ content: 'partial', done: false });
    expect(onChatPreview).toHaveBeenCalledTimes(1);
  });

  it('returns null when session events cannot be opened', () => {
    expect(setupBtwSessionEvents({ sessionId: '', EventSourceImpl: class {} })).toBe(null);
    expect(setupBtwSessionEvents({ sessionId: 's1', EventSourceImpl: null })).toBe(null);
  });

  it('wires parent btw-changed events', () => {
    const instances = [];
    const EventSourceImpl = fakeEventSourceClass(instances);
    const onChanged = vi.fn();
    const source = setupBtwParentEvents({
      parentTopic: 'parent.jsonl',
      EventSourceImpl,
      onChanged,
    });

    source.emit('btw-changed', JSON.stringify({ sessionId: 'btw-1.jsonl' }));
    source.emit('btw-changed', JSON.stringify({}));
    source.emit('btw-changed', '{bad');
    expect(onChanged).toHaveBeenNthCalledWith(1, 'btw-1.jsonl');
    expect(onChanged).toHaveBeenNthCalledWith(2, '');
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('closes EventSource defensively', () => {
    const close = vi.fn(() => {
      throw new Error('already closed');
    });
    expect(() => closeBtwEventSource({ close })).not.toThrow();
    expect(close).toHaveBeenCalled();
    expect(() => closeBtwEventSource(null)).not.toThrow();
  });
});
