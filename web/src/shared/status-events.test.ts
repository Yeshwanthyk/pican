import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStatusEvents } from "./status-events.js";

type Listener = (event: Event) => void;

class FakeEventSource {
  static instances: Array<FakeEventSource> = [];
  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly listeners: Record<string, Array<Listener>> = {};
  readonly close = vi.fn();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener) {
    (this.listeners[name] ??= []).push(listener);
  }

  emit(name: string, data = "") {
    const event = new MessageEvent(name, { data });
    if (name === "message") {
      this.onmessage?.(event);
      return;
    }
    this.listeners[name]?.forEach((listener) => listener(event));
  }
}

describe("createStatusEvents", () => {
  beforeEach(() => (FakeEventSource.instances = []));

  it("subscribes and exposes synchronously parsed callbacks", () => {
    const calls: Array<string> = [];
    const onSnapshot = vi.fn(() => calls.push("snapshot"));
    const onDelta = vi.fn(() => calls.push("delta"));
    const onMessage = vi.fn(() => calls.push("message"));
    const onWorkflowUpdate = vi.fn();
    const onTasksUpdate = vi.fn();
    const onCurationUpdate = vi.fn();
    const sub = createStatusEvents({
      EventSourceImpl: FakeEventSource,
      onSnapshot,
      onDelta,
      onMessage,
      onWorkflowUpdate,
      onTasksUpdate,
      onCurationUpdate,
    });
    sub.connect();
    const eventSource = FakeEventSource.instances[0];
    expect(eventSource?.url).toBe("/events?id=__all__");
    eventSource?.emit(
      "status-snapshot",
      '{"running":["a.jsonl"],"statuses":{"a.jsonl":{"model":"m","modelProvider":"p"}}}',
    );
    eventSource?.emit(
      "status-delta",
      '{"id":"a.jsonl","running":false,"model":"m","modelProvider":"p"}',
    );
    eventSource?.emit("message", "new-session");
    eventSource?.emit("workflows-updated", '{"runId":"wf_123456abcdef"}');
    eventSource?.emit("tasks-updated", '{"project":"/repo"}');
    eventSource?.emit("curation-updated", '{"ok":true}');
    expect(onSnapshot).toHaveBeenCalledWith({
      ids: ["a.jsonl"],
      statuses: { "a.jsonl": { model: "m", modelProvider: "p" } },
    });
    expect(onDelta).toHaveBeenCalledWith({
      id: "a.jsonl",
      running: false,
      model: "m",
      modelName: "",
      modelProvider: "p",
    });
    expect(onMessage).toHaveBeenCalledWith("new-session");
    expect(onWorkflowUpdate).toHaveBeenCalledWith({ runId: "wf_123456abcdef" });
    expect(onTasksUpdate).toHaveBeenCalledWith({ project: "/repo" });
    expect(onCurationUpdate).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["snapshot", "delta", "message"]);
  });

  it("drops malformed typed payloads without affecting the connection", () => {
    const onSnapshot = vi.fn();
    const onDelta = vi.fn();
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, onSnapshot, onDelta });
    sub.connect();
    const eventSource = FakeEventSource.instances[0];
    eventSource?.emit("status-snapshot", "{bad");
    eventSource?.emit("status-snapshot", '{"running":"a.jsonl"}');
    eventSource?.emit("status-delta", '{"running":true}');
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onDelta).not.toHaveBeenCalled();
    expect(eventSource?.close).not.toHaveBeenCalled();
  });

  it("closes before explicit reconnect and removes lifecycle listeners", () => {
    const removeEventListener = vi.fn();
    const addEventListener = vi.fn();
    const sub = createStatusEvents({
      EventSourceImpl: FakeEventSource,
      windowImpl: { addEventListener, removeEventListener },
    });
    sub.connect();
    const first = FakeEventSource.instances[0];
    sub.connect();
    expect(first?.close).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith("pageshow", expect.any(Function));
    sub.cleanup();
    expect(FakeEventSource.instances[1]?.close).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledWith("pagehide", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("pageshow", expect.any(Function));
  });

  it("lets the browser own reconnect and reports every open after the first", () => {
    const onReconnect = vi.fn();
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, onReconnect });
    sub.connect();
    const eventSource = FakeEventSource.instances[0];
    eventSource?.emit("open");
    expect(onReconnect).not.toHaveBeenCalled();
    eventSource?.emit("open");
    eventSource?.emit("open");
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("reconnects after pagehide/pageshow", () => {
    const listeners: Record<string, EventListener> = {};
    const windowImpl = {
      addEventListener: (name: string, listener: EventListener) => (listeners[name] = listener),
      removeEventListener: () => undefined,
    };
    const onReconnect = vi.fn();
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, windowImpl, onReconnect });
    sub.connect();
    FakeEventSource.instances[0]?.emit("open");
    listeners.pagehide?.(new Event("pagehide"));
    listeners.pageshow?.(new Event("pageshow"));
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]?.emit("open");
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("calls onMessage before routing reload broadcasts", () => {
    const order: Array<string> = [];
    const onReload = vi.fn(() => order.push("reload"));
    const onMessage = vi.fn(() => order.push("message"));
    const sub = createStatusEvents({ EventSourceImpl: FakeEventSource, onReload, onMessage });
    sub.connect();
    const eventSource = FakeEventSource.instances[0];
    eventSource?.emit("message", "reload:abc_123.jsonl");
    expect(onReload).toHaveBeenCalledWith({ id: "abc_123.jsonl" });
    expect(order).toEqual(["message", "reload"]);
    eventSource?.emit("message", "reload");
    expect(onReload).toHaveBeenCalledWith({ id: "" });
    eventSource?.emit("message", "new-session");
    expect(onReload).toHaveBeenCalledTimes(2);
  });
});
