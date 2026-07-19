import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runPromise } from "./runtime";
import { parseStatusEvent } from "./sse";

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
