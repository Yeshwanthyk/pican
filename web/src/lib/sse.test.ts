import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { runPromise } from "./runtime";
import { parseStatusEvent, statusEvents } from "./sse";

describe("SSE parsing", () => {
  it("parses reload and typed status events", async () => {
    await expect(runPromise(parseStatusEvent("message", "reload:s.jsonl"))).resolves.toEqual({
      type: "reload",
      id: "s.jsonl",
    });
    await expect(
      runPromise(parseStatusEvent("status-delta", '{"id":"s.jsonl","running":true,"model":"gpt"}')),
    ).resolves.toMatchObject({ type: "status-delta", data: { id: "s.jsonl" } });
  });

  it("maps malformed typed payloads to SseError", async () => {
    await expect(
      runPromise(Effect.flip(parseStatusEvent("status-snapshot", "nope"))),
    ).resolves.toMatchObject({ _tag: "SseError", phase: "parse" });
  });
});

class FakeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  readonly listeners: Record<string, Array<EventListener>> = {};
  readonly close = vi.fn();

  addEventListener(name: string, listener: EventListener) {
    (this.listeners[name] ??= []).push(listener);
  }

  emit(name: string, data = "") {
    const event = new MessageEvent(name, { data });
    if (name === "message") this.onmessage?.(event);
    else this.listeners[name]?.forEach((listener) => listener(event));
  }
}

describe("SSE stream", () => {
  it("drops malformed typed payloads and keeps the same browser connection", async () => {
    const source = new FakeEventSource();
    const factory = vi.fn(() => source);
    const result = runPromise(
      statusEvents("__all__", factory).pipe(Stream.take(1), Stream.runCollect),
    );
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    source.emit("status-delta", "{bad");
    source.emit("error");
    source.emit("status-delta", '{"id":"s","running":true}');
    await expect(result).resolves.toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
