import { assert, describe, expect, it, vi } from "vitest";
import {
  closeBtwEventSource,
  createBtwEventSource,
  setupBtwParentEvents,
  setupBtwSessionEvents,
} from "./btw-events.js";

class FakeEventSource extends EventTarget implements EventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly withCredentials = false;
  readonly readyState = 1;
  onerror: ((this: EventSource, event: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
  onopen: ((this: EventSource, event: Event) => unknown) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();
  readonly close = vi.fn();

  constructor(
    readonly url: string,
    instances: FakeEventSource[],
  ) {
    super();
    instances.push(this);
  }

  addEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, event: EventSourceEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: (this: EventSource, event: MessageEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: unknown,
    options?: boolean | AddEventListenerOptions,
  ): void {
    void options;
    if (typeof listener === "function") {
      this.listeners.set(type, (event) => listener.call(this, event));
    }
  }

  removeEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, event: EventSourceEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (this: EventSource, event: MessageEvent) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    void listener;
    void options;
    this.listeners.delete(type);
  }

  emit(type: string, data: string): void {
    this.listeners.get(type)?.(new MessageEvent(type, { data }));
  }
}

function fakeEventSourceClass(instances: FakeEventSource[]): typeof EventSource {
  return class BoundFakeEventSource extends FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    constructor(url: string | URL) {
      super(String(url), instances);
    }
  };
}

describe("btw events", () => {
  it("creates encoded EventSource URLs", () => {
    const instances: FakeEventSource[] = [];
    const EventSourceImpl = fakeEventSourceClass(instances);
    const source = createBtwEventSource("parent session.jsonl", { EventSourceImpl });
    expect(source.url).toBe("/events?id=parent%20session.jsonl");
  });

  it("wires session reload and chat-preview events", () => {
    const instances: FakeEventSource[] = [];
    const EventSourceImpl = fakeEventSourceClass(instances);
    const onReload = vi.fn();
    const onChatPreview = vi.fn();
    const source = setupBtwSessionEvents({
      sessionId: "s1.jsonl",
      EventSourceImpl,
      onReload,
      onChatPreview,
    });

    assert(source);
    assert(source.onmessage);
    source.onmessage.call(source, new MessageEvent("message", { data: "noop" }));
    source.onmessage.call(source, new MessageEvent("message", { data: "reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);

    const fakeSource = instances[0];
    assert(fakeSource);
    fakeSource.emit("chat-preview", JSON.stringify({ content: "partial", done: false }));
    fakeSource.emit("chat-preview", "{bad");
    expect(onChatPreview).toHaveBeenCalledWith({ content: "partial", done: false });
    expect(onChatPreview).toHaveBeenCalledTimes(1);
  });

  it("returns null when session events cannot be opened", () => {
    expect(
      setupBtwSessionEvents({ sessionId: "", EventSourceImpl: fakeEventSourceClass([]) }),
    ).toBe(null);
    expect(setupBtwSessionEvents({ sessionId: "s1", EventSourceImpl: null })).toBe(null);
  });

  it("wires parent btw-changed events", () => {
    const instances: FakeEventSource[] = [];
    const EventSourceImpl = fakeEventSourceClass(instances);
    const onChanged = vi.fn();
    const source = setupBtwParentEvents({
      parentTopic: "parent.jsonl",
      EventSourceImpl,
      onChanged,
    });

    assert(source);
    const fakeSource = instances[0];
    assert(fakeSource);
    fakeSource.emit("btw-changed", JSON.stringify({ sessionId: "btw-1.jsonl" }));
    fakeSource.emit("btw-changed", JSON.stringify({}));
    fakeSource.emit("btw-changed", "{bad");
    expect(onChanged).toHaveBeenNthCalledWith(1, "btw-1.jsonl");
    expect(onChanged).toHaveBeenNthCalledWith(2, "");
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("closes EventSource defensively", () => {
    const close = vi.fn(() => expect.fail("already closed"));
    expect(() => closeBtwEventSource({ close })).not.toThrow();
    expect(close).toHaveBeenCalled();
    expect(() => closeBtwEventSource(null)).not.toThrow();
  });
});
