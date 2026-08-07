import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  DEFAULT_HEARTBEAT_STALE_MS,
  reconnectDelay,
  setupSessionLiveConnection,
} from "./live-connection.js";
import type { EventSourceLike } from "./live-events.js";
import type { wireSessionEvents } from "./live-events.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setupDom() {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/session?id=s1" });
  let hidden = false;
  Object.defineProperty(dom.window.document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  return { dom, setHidden: (value: boolean) => (hidden = value) };
}

function createClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  const runDue = () => {
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= current)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
    }
  };
  return {
    now: () => current,
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextId++;
      timers.set(id, { at: current + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    advance: (milliseconds: number) => {
      current += milliseconds;
      runDue();
    },
    pending: () => [...timers.values()].map((timer) => timer.at - current).sort((a, b) => a - b),
  };
}

type FakeSource = EventSourceLike & { readyState: number; close: () => void };

function source(readyState = 1): FakeSource {
  return {
    readyState,
    close: vi.fn<() => void>(),
    addEventListener: vi.fn(),
  };
}

type WiredOptions = Parameters<typeof wireSessionEvents>[0];
type TestReload = (
  event?: unknown,
  shouldApply?: () => boolean,
) => boolean | void | PromiseLike<boolean | void>;

function connectionHarness({
  onReload = vi.fn<TestReload>(() => Promise.resolve(true)),
  clock = createClock(),
}: {
  readonly onReload?: TestReload;
  readonly clock?: ReturnType<typeof createClock>;
} = {}) {
  const { dom, setHidden } = setupDom();
  const sources: ReturnType<typeof source>[] = [];
  const wired: WiredOptions[] = [];
  const states: string[] = [];
  const createEventSource = vi.fn(() => {
    const next = source();
    sources.push(next);
    return next;
  });
  const connection = setupSessionLiveConnection({
    documentImpl: dom.window.document,
    windowImpl: dom.window,
    sessionId: "s1",
    createEventSource,
    wireEvents: (options) => wired.push(options),
    onReload,
    onStateChange: (state) => states.push(state),
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    randomImpl: () => 0,
  });
  return {
    dom,
    setHidden,
    clock,
    sources,
    wired,
    states,
    onReload,
    createEventSource,
    connection,
  };
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

describe("live connection", () => {
  it("computes capped reconnect delays with jitter", () => {
    expect(reconnectDelay(0, { randomImpl: () => 0 })).toBe(1000);
    expect(reconnectDelay(1, { randomImpl: () => 0.25 })).toBe(2125);
    expect(reconnectDelay(10, { randomImpl: () => 0.998 })).toBe(30499);
  });

  it("accepts the initial authoritative page load without refetching on first open", async () => {
    const harness = connectionHarness();
    harness.connection.connect();

    harness.wired[0]?.onOpen?.();
    await flush();
    expect(harness.onReload).not.toHaveBeenCalled();
    expect(harness.connection.currentState()).toBe("current");
    expect(harness.states.at(-1)).toBe("current");
    harness.connection.dispose();
  });

  it("catches up after a native EventSource reopen without replacing the stream", async () => {
    const harness = connectionHarness();
    harness.connection.connect();
    const first = harness.sources[0];
    const events = harness.wired[0];

    events?.onOpen?.();
    await flush();
    expect(harness.onReload).not.toHaveBeenCalled();
    expect(harness.connection.currentState()).toBe("current");

    if (first) first.readyState = 0;
    events?.onTransportError?.(new Event("error"));
    expect(harness.connection.currentState()).toBe("reconnecting");
    expect(harness.sources).toHaveLength(1);

    events?.onOpen?.();
    await flush();
    expect(harness.sources).toHaveLength(1);
    expect(harness.onReload).toHaveBeenCalledTimes(1);
    expect(harness.connection.currentState()).toBe("current");
    harness.connection.dispose();
  });

  it("does not reset replacement backoff until a transport actually opens", () => {
    const harness = connectionHarness();
    harness.connection.connect();
    const first = harness.sources[0];
    if (first) first.readyState = 2;
    harness.wired[0]?.onTransportError?.(new Event("error"));
    expect(harness.clock.pending()).toContain(1000);

    harness.clock.advance(1000);
    const second = harness.sources[1];
    if (second) second.readyState = 2;
    harness.wired[1]?.onTransportError?.(new Event("error"));
    expect(harness.clock.pending()).toContain(2000);
    harness.connection.dispose();
  });

  it("suppresses old-generation events, timers, and recovery completion", async () => {
    const oldRecovery = deferred<boolean>();
    const newRecovery = deferred<boolean>();
    const onReload = vi
      .fn()
      .mockReturnValueOnce(oldRecovery.promise)
      .mockReturnValueOnce(newRecovery.promise);
    const harness = connectionHarness({ onReload });
    harness.connection.connect();
    const oldEvents = harness.wired[0];
    oldEvents?.onOpen?.();
    oldEvents?.onReload?.({ data: "reload" });
    await flush();
    const oldGuard = onReload.mock.calls[0]?.[1] as (() => boolean) | undefined;
    expect(oldGuard?.()).toBe(true);

    harness.dom.window.dispatchEvent(new harness.dom.window.Event("online"));
    expect(oldGuard?.()).toBe(false);
    expect(harness.sources[0]?.close).toHaveBeenCalledTimes(1);
    oldEvents?.onHeartbeat?.({
      timestamp: "2026-05-08T09:00:00Z",
      freshness: "transport-only",
    });
    oldEvents?.onReload?.({ data: "reload" });
    expect(onReload).toHaveBeenCalledTimes(1);

    oldRecovery.resolve(true);
    await flush();
    expect(harness.connection.currentState()).not.toBe("current");

    harness.wired[1]?.onOpen?.();
    await flush();
    newRecovery.resolve(true);
    await flush();
    expect(harness.connection.currentState()).toBe("current");
    harness.connection.dispose();
  });

  it("coalesces simultaneous open, reload, and lifecycle recovery triggers", async () => {
    const recovery = deferred<boolean>();
    const onReload = vi.fn(() => recovery.promise);
    const harness = connectionHarness({ onReload });
    harness.connection.connect();
    harness.wired[0]?.onOpen?.();
    harness.wired[0]?.onReload?.({ data: "reload" });
    void harness.connection.recover();
    harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
    await flush();
    expect(onReload).toHaveBeenCalledTimes(1);

    recovery.resolve(true);
    await flush();
    expect(harness.connection.currentState()).toBe("current");
    harness.connection.dispose();
  });

  it("replaces a heartbeat-stale visible stream and recovers authoritatively", async () => {
    const harness = connectionHarness();
    harness.connection.connect();
    harness.wired[0]?.onOpen?.();
    await flush();
    harness.clock.advance(10_000);
    harness.wired[0]?.onHeartbeat?.({
      timestamp: "2026-05-08T09:00:15Z",
      freshness: "transport-only",
    });

    harness.clock.advance(DEFAULT_HEARTBEAT_STALE_MS - 1);
    expect(harness.connection.currentState()).toBe("current");
    expect(harness.sources).toHaveLength(1);
    harness.clock.advance(1);
    expect(harness.connection.currentState()).toBe("stale");
    expect(harness.sources).toHaveLength(2);

    harness.wired[1]?.onOpen?.();
    await flush();
    expect(harness.onReload).toHaveBeenCalledTimes(1);
    expect(harness.connection.currentState()).toBe("current");
    harness.connection.dispose();
  });

  it("does not show timer staleness in the background and checks it on visibility return", async () => {
    const harness = connectionHarness();
    harness.connection.connect();
    harness.wired[0]?.onOpen?.();
    await flush();

    harness.setHidden(true);
    harness.clock.advance(DEFAULT_HEARTBEAT_STALE_MS + 1);
    expect(harness.connection.currentState()).toBe("current");
    expect(harness.sources).toHaveLength(1);

    harness.setHidden(false);
    harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
    expect(harness.connection.currentState()).toBe("stale");
    expect(harness.sources).toHaveLength(2);
    harness.connection.dispose();
  });

  it("refetches on a fresh visibility return without replacing the open stream", async () => {
    const harness = connectionHarness();
    harness.connection.connect();
    harness.wired[0]?.onOpen?.();
    await flush();

    harness.setHidden(true);
    harness.clock.advance(10_000);
    harness.setHidden(false);
    harness.dom.window.document.dispatchEvent(new harness.dom.window.Event("visibilitychange"));
    await flush();
    expect(harness.sources).toHaveLength(1);
    expect(harness.onReload).toHaveBeenCalledTimes(1);
    expect(harness.connection.currentState()).toBe("current");
    harness.connection.dispose();
  });

  it("closes on pagehide and catches up after pageshow opens a new generation", async () => {
    const harness = connectionHarness();
    harness.connection.connect();
    harness.wired[0]?.onOpen?.();
    await flush();

    harness.dom.window.dispatchEvent(new harness.dom.window.Event("pagehide"));
    expect(harness.sources[0]?.close).toHaveBeenCalledTimes(1);
    expect(harness.connection.currentEventSource()).toBeNull();
    harness.dom.window.dispatchEvent(new harness.dom.window.Event("pageshow"));
    expect(harness.sources).toHaveLength(2);
    harness.wired[1]?.onOpen?.();
    await flush();
    expect(harness.onReload).toHaveBeenCalledTimes(1);
    expect(harness.connection.currentState()).toBe("current");
    harness.connection.dispose();
  });
});
