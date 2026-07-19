import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { get, post } from "./http";
import { runPromise } from "./runtime";

const ResultSchema = Schema.Struct({ ok: Schema.Boolean });
const failed = <E>(effect: Effect.Effect<unknown, E>) => runPromise(Effect.flip(effect));

describe("apiFetch", () => {
  it.each([
    {
      name: "network rejection",
      fetchImpl: () => runPromise(Effect.fail("offline")),
      tag: "NetworkError",
    },
    {
      name: "non-2xx response",
      fetchImpl: () => Promise.resolve(new Response("denied", { status: 401 })),
      tag: "HttpError",
    },
    {
      name: "invalid JSON",
      fetchImpl: () => Promise.resolve(new Response("not-json", { status: 200 })),
      tag: "DecodeError",
    },
  ])("maps $name", async ({ fetchImpl, tag }) => {
    await expect(failed(get("/api/test", ResultSchema, { fetchImpl }))).resolves.toMatchObject({
      _tag: tag,
    });
  });

  it("maps an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = () => Promise.resolve(new Response('{"ok":true}'));
    await expect(
      failed(get("/api/test", ResultSchema, { fetchImpl, signal: controller.signal })),
    ).resolves.toMatchObject({ _tag: "AbortError" });
  });

  it("maps request timeouts", async () => {
    const fetchImpl = () => new Promise<Response>(() => undefined);
    await expect(
      failed(get("/api/slow", ResultSchema, { fetchImpl, timeoutMillis: 1 })),
    ).resolves.toMatchObject({ _tag: "TimeoutError", url: "/api/slow", millis: 1 });
  });

  it("decodes success and schema-encodes request bodies", async () => {
    let body = "";
    const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    };
    await expect(
      runPromise(post("/api/test", { value: 1 }, ResultSchema, { fetchImpl })),
    ).resolves.toEqual({
      ok: true,
    });
    expect(body).toBe('{"value":1}');
  });
});
