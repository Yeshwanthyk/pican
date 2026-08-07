import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeSessionPrefetch, prefetchSession, resetSessionPrefetch } from "./session-prefetch";

afterEach(() => resetSessionPrefetch());

describe("session-prefetch", () => {
  it("starts an /api/session fetch and lets consume await the same promise", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ name: "Prefetched" }));
    };

    prefetchSession("s.jsonl", { fetchImpl });
    const data = await consumeSessionPrefetch("s.jsonl");

    expect(calls).toEqual(["/api/session?id=s.jsonl&paginate=1"]);
    expect(data).toEqual({ name: "Prefetched" });
  });

  it("dedupes prefetch and consume intents for the same id", async () => {
    let calls = 0;
    let resolveResponse!: (response: Response) => void;
    const fetchImpl = () => {
      calls++;
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      });
    };

    prefetchSession("s.jsonl", { fetchImpl });
    prefetchSession("s.jsonl", { fetchImpl });
    const first = consumeSessionPrefetch("s.jsonl");
    const second = consumeSessionPrefetch("s.jsonl");
    prefetchSession("s.jsonl", { fetchImpl });

    expect(first).not.toBe(null);
    expect(second).toBe(first);
    expect(calls).toBe(1);

    resolveResponse(new Response(JSON.stringify({ name: "Shared" })));
    await expect(first).resolves.toEqual({ name: "Shared" });
  });

  it("interrupts the oldest request when the 16-entry cache evicts it", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    };

    for (let index = 0; index < 17; index += 1) {
      prefetchSession(`s-${index}.jsonl`, { fetchImpl });
    }

    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    expect(signals).toHaveLength(17);
    expect(signals.slice(1).every((signal) => !signal.aborted)).toBe(true);
  });

  it("never evicts a consumed request that is serving navigation", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    };

    prefetchSession("navigating.jsonl", { fetchImpl });
    const navigation = consumeSessionPrefetch("navigating.jsonl");
    expect(navigation).not.toBe(null);
    void navigation?.catch(() => undefined);
    for (let index = 0; index < 16; index += 1) {
      prefetchSession(`hover-${index}.jsonl`, { fetchImpl });
    }

    await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
    expect(signals[0]?.aborted).toBe(false);
  });

  it("interrupts every cached request on reset", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    };

    prefetchSession("one.jsonl", { fetchImpl });
    prefetchSession("two.jsonl", { fetchImpl });
    resetSessionPrefetch();

    await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
    expect(signals).toHaveLength(2);
  });

  it("does not let a stale evicted request remove a newer request for the same id", async () => {
    let rejectStale!: (error: unknown) => void;
    let staleSignal: AbortSignal | undefined;
    const staleFetch = (_url: RequestInfo | URL, init?: RequestInit) => {
      staleSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        rejectStale = reject;
      });
    };
    const pendingFetch = () => new Promise<Response>(() => undefined);

    prefetchSession("same.jsonl", { fetchImpl: staleFetch });
    for (let index = 0; index < 16; index += 1) {
      prefetchSession(`filler-${index}.jsonl`, { fetchImpl: pendingFetch });
    }
    await vi.waitFor(() => expect(staleSignal?.aborted).toBe(true));

    prefetchSession("same.jsonl", {
      fetchImpl: async () => new Response(JSON.stringify({ name: "New request" })),
    });
    rejectStale("stale request settled after eviction");
    await Promise.resolve();

    await expect(consumeSessionPrefetch("same.jsonl")).resolves.toEqual({ name: "New request" });
  });

  it("removes the entry once consumed so the next call goes back to the network", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response("{}");
    };
    prefetchSession("s.jsonl", { fetchImpl });
    await consumeSessionPrefetch("s.jsonl");
    expect(consumeSessionPrefetch("s.jsonl")).toBe(null);
    expect(calls).toBe(1);
  });

  it("returns null when there is no prefetch for the id", () => {
    expect(consumeSessionPrefetch("nope")).toBe(null);
  });

  it("drops a rejected prefetch so callers fall back to a fresh fetch", async () => {
    const fetchImpl = async () => new Response("{}", { status: 500 });
    prefetchSession("s.jsonl", { fetchImpl });
    const promise = consumeSessionPrefetch("s.jsonl");
    expect(promise).not.toBe(null);
    await expect(promise).rejects.toThrow();
    // Entry was already removed when consumed; another consume returns null.
    expect(consumeSessionPrefetch("s.jsonl")).toBe(null);
  });
});
