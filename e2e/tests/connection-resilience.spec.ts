import { rmSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { test as baseTest, expect, collapseRightSidebar, waitForSessionReady } from "../lib/test";
import {
  appendEntry,
  assistantTextEntry,
  buildSession,
  realWorkingDir,
  uniqueSessionName,
  writeSession,
} from "../lib/sessions";
import { startIsolatedServer, type StartedIsolatedServer } from "../lib/server";

interface CanonicalEntry {
  readonly id?: unknown;
  readonly message?: {
    readonly role?: unknown;
    readonly content?: unknown;
  };
}

interface CanonicalSession {
  readonly entries: CanonicalEntry[];
}

interface MetricsResponse {
  readonly process: {
    readonly sse_clients: number;
    readonly sse_global_streams: number;
    readonly sse_session_streams: number;
  };
}

interface ConnectionFaultControl {
  blockSession(): void;
  releaseSession(): void;
  setHidden(hidden: boolean): void;
}

interface SendFaultControl {
  readonly attempts: number;
}

const test = baseTest.extend<{
  isolatedServer: StartedIsolatedServer;
  workingDir: string;
}>({
  isolatedServer: async ({}, use) => {
    const server = await startIsolatedServer();
    try {
      await use(server);
    } finally {
      await server.stop();
    }
  },
  workingDir: async ({}, use) => {
    const cwd = realWorkingDir();
    try {
      await use(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
});

test.describe.configure({ mode: "serial" });

async function configureIsolatedServer(
  request: APIRequestContext,
  server: StartedIsolatedServer,
): Promise<void> {
  const response = await request.post(`${server.baseURL}/api/settings`, {
    data: {
      settings: {
        "pican:v1:auto-title:enabled": "false",
        "pican:v1:artifacts:include": "",
        "pican:v1:session-tabs": "true",
      },
    },
  });
  expect(response.ok()).toBeTruthy();
}

async function enableGlobalAndSessionStreams(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("pican:v1:session-tabs", "true");
  });
}

async function installConnectionFaultControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    let blockSessionStreams = false;
    let documentHidden = false;
    const instances = new Set<ControlledEventSource>();

    const isSessionStream = (rawURL: string): boolean => {
      const url = new URL(rawURL, window.location.href);
      return url.pathname.endsWith("/events") && url.searchParams.get("id") !== "__all__";
    };

    class ControlledEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;

      readonly url: string;
      readonly withCredentials: boolean;
      readyState = ControlledEventSource.CONNECTING;
      onopen: ((event: Event) => unknown) | null = null;
      onmessage: ((event: MessageEvent) => unknown) | null = null;
      onerror: ((event: Event) => unknown) | null = null;

      private source: EventSource | null = null;
      private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
      private forwarded = new Set<string>();
      private intentionallyClosed = false;

      constructor(rawURL: string, init?: EventSourceInit) {
        this.url = new URL(rawURL, window.location.href).href;
        this.withCredentials = init?.withCredentials === true;
        instances.add(this);
        if (blockSessionStreams && isSessionStream(this.url)) {
          queueMicrotask(() => this.fail());
          return;
        }
        this.connect(rawURL, init);
      }

      private connect(rawURL: string, init?: EventSourceInit): void {
        const source = new NativeEventSource(rawURL, init);
        this.source = source;
        this.readyState = source.readyState;
        source.onopen = (event) => {
          if (this.intentionallyClosed) return;
          this.readyState = ControlledEventSource.OPEN;
          this.onopen?.(event);
        };
        source.onmessage = (event) => {
          if (this.intentionallyClosed) return;
          this.onmessage?.(event);
        };
        source.onerror = (event) => {
          if (this.intentionallyClosed) return;
          this.readyState = source.readyState;
          this.onerror?.(event);
        };
        for (const type of this.listeners.keys()) this.forward(type);
      }

      private emit(type: string, event: Event): void {
        for (const listener of this.listeners.get(type) ?? []) {
          if (typeof listener === "function") listener.call(this, event);
          else listener.handleEvent(event);
        }
      }

      private forward(type: string): void {
        if (!this.source || this.forwarded.has(type)) return;
        this.forwarded.add(type);
        this.source.addEventListener(type, (event) => this.emit(type, event));
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener) return;
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
        this.forward(type);
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (listener) this.listeners.get(type)?.delete(listener);
      }

      close(): void {
        this.intentionallyClosed = true;
        this.readyState = ControlledEventSource.CLOSED;
        this.source?.close();
        this.source = null;
        instances.delete(this);
      }

      fail(): void {
        if (this.intentionallyClosed || !isSessionStream(this.url)) return;
        this.source?.close();
        this.source = null;
        this.readyState = ControlledEventSource.CLOSED;
        queueMicrotask(() => {
          if (!this.intentionallyClosed) this.onerror?.(new Event("error"));
        });
      }
    }

    try {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => documentHidden,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (documentHidden ? "hidden" : "visible"),
      });
    } catch {
      // Supported Playwright engines allow these own-property overrides. If a
      // future engine does not, its native visibility state remains in force.
    }

    const control: ConnectionFaultControl = {
      blockSession() {
        blockSessionStreams = true;
        for (const instance of [...instances]) instance.fail();
      },
      releaseSession() {
        blockSessionStreams = false;
      },
      setHidden(hidden) {
        documentHidden = hidden;
        document.dispatchEvent(new Event("visibilitychange"));
      },
    };

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: ControlledEventSource,
    });
    Object.defineProperty(window, "__connectionResilience", {
      configurable: true,
      value: control,
    });
  });
}

async function installFailedSendControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    let attempts = 0;
    const control: SendFaultControl = {
      get attempts() {
        return attempts;
      },
    };
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const rawURL = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const url = new URL(rawURL, window.location.href);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (url.pathname === "/api/chat" && method === "POST") {
        attempts += 1;
        if (attempts === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "simulated send failure" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            }),
          );
        }
      }
      return nativeFetch(input, init);
    }) as typeof window.fetch;
    Object.defineProperty(window, "__sendFault", {
      configurable: true,
      value: control,
    });
  });
}

async function sendAttempts(page: Page): Promise<number> {
  return page.evaluate(() => {
    const control = (window as typeof window & { __sendFault?: SendFaultControl }).__sendFault;
    if (!control) throw new Error("send fault control was not installed");
    return control.attempts;
  });
}

async function setControlledVisibility(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((nextHidden) => {
    const control = (window as typeof window & { __connectionResilience?: ConnectionFaultControl })
      .__connectionResilience;
    if (!control) throw new Error("connection fault control was not installed");
    control.setHidden(nextHidden);
  }, hidden);
}

async function blockSessionStream(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (window as typeof window & { __connectionResilience?: ConnectionFaultControl })
      .__connectionResilience;
    if (!control) throw new Error("connection fault control was not installed");
    control.blockSession();
  });
}

async function releaseSessionStream(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (window as typeof window & { __connectionResilience?: ConnectionFaultControl })
      .__connectionResilience;
    if (!control) throw new Error("connection fault control was not installed");
    control.releaseSession();
  });
}

function canonicalIds(session: CanonicalSession): string[] {
  return session.entries.flatMap((entry) =>
    typeof entry.id === "string" && entry.id ? [entry.id] : [],
  );
}

function entryText(entry: CanonicalEntry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? [String((part as { text: unknown }).text)]
        : [],
    )
    .join("");
}

async function readCanonical(
  request: APIRequestContext,
  server: StartedIsolatedServer,
  sessionId: string,
): Promise<CanonicalSession> {
  const response = await request.get(
    `${server.baseURL}/api/session?id=${encodeURIComponent(sessionId)}`,
  );
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as { entries?: unknown };
  expect(Array.isArray(payload.entries)).toBeTruthy();
  return { entries: payload.entries as CanonicalEntry[] };
}

async function readRenderedIds(page: Page): Promise<string[]> {
  return page
    .locator('#messages [id^="entry-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.id.slice("entry-".length)));
}

function expectOrderedUnique(ids: string[]): void {
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
}

async function expectSettledStreamCounts(
  request: APIRequestContext,
  server: StartedIsolatedServer,
  expectedGlobal = 1,
  expectedSession = 1,
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const response = await request.get(`${server.baseURL}/api/metrics`);
          if (!response.ok()) return [-1, -1, -1];
          const metrics = (await response.json()) as MetricsResponse;
          return [
            metrics.process.sse_global_streams,
            metrics.process.sse_session_streams,
            metrics.process.sse_clients,
          ];
        } catch {
          return [-1, -1, -1];
        }
      },
      { timeout: 15_000, intervals: [100, 200, 500] },
    )
    .toEqual([expectedGlobal, expectedSession, expectedGlobal + expectedSession]);
}

test.describe("connection resilience", () => {
  test("SSE-only interruption catches up authoritative append on visibility resume", async ({
    isolatedServer,
    page,
    request,
  }, testInfo) => {
    await configureIsolatedServer(request, isolatedServer);
    const { entries, lastId } = buildSession();
    const name = uniqueSessionName(testInfo, "resilience-sse");
    const sessionId = writeSession(isolatedServer.sessionsDir, name, entries);

    await enableGlobalAndSessionStreams(page);
    await installConnectionFaultControl(page);
    await page.goto(`${isolatedServer.baseURL}/session?id=${encodeURIComponent(sessionId)}`);
    await waitForSessionReady(page);
    await expectSettledStreamCounts(request, isolatedServer);

    const before = await readCanonical(request, isolatedServer, sessionId);
    const beforeIds = canonicalIds(before);
    const beforeRenderedIds = await readRenderedIds(page);
    expectOrderedUnique(beforeIds);
    expectOrderedUnique(beforeRenderedIds);

    await setControlledVisibility(page, true);
    await blockSessionStream(page);
    await expectSettledStreamCounts(request, isolatedServer, 1, 0);

    // Only EventSource is faulted: ordinary same-origin fetch remains online.
    const onlineRead = await page.evaluate(async (id) => {
      const response = await fetch(`/api/session?id=${encodeURIComponent(id)}`);
      const payload = (await response.json()) as { entries?: Array<{ id?: unknown }> };
      return {
        ok: response.ok,
        ids: (payload.entries ?? []).flatMap((entry) =>
          typeof entry.id === "string" ? [entry.id] : [],
        ),
      };
    }, sessionId);
    expect(onlineRead).toEqual({ ok: true, ids: beforeIds });

    const marker = `SSE_RESUME_${testInfo.workerIndex}_${Date.now()}`;
    const { id: markerId, entry } = assistantTextEntry(lastId, marker);
    appendEntry(isolatedServer.sessionsDir, name, entry);

    await page.waitForTimeout(400);
    await expect(page.locator(`#entry-${markerId}`)).toHaveCount(0);

    await releaseSessionStream(page);
    await setControlledVisibility(page, false);
    await expect(page.locator(`#entry-${markerId}`)).toHaveCount(1, {
      timeout: 15_000,
    });

    const after = await readCanonical(request, isolatedServer, sessionId);
    const afterIds = canonicalIds(after);
    expect(afterIds).toEqual([...beforeIds, markerId]);
    expectOrderedUnique(afterIds);
    expect(afterIds.filter((id) => id === markerId)).toHaveLength(1);
    await expect(page.getByText(marker, { exact: true })).toHaveCount(1);

    const afterRenderedIds = await readRenderedIds(page);
    expect(afterRenderedIds).toEqual([...beforeRenderedIds, markerId]);
    expectOrderedUnique(afterRenderedIds);
    await expectSettledStreamCounts(request, isolatedServer);
  });

  test("same-port server restart preserves URL, draft, and canonical state", async ({
    isolatedServer,
    page,
    request,
    workingDir,
  }, testInfo) => {
    await configureIsolatedServer(request, isolatedServer);
    const { entries, lastId } = buildSession({ cwd: workingDir });
    const name = uniqueSessionName(testInfo, "resilience-restart");
    const sessionId = writeSession(isolatedServer.sessionsDir, name, entries);

    await enableGlobalAndSessionStreams(page);
    await collapseRightSidebar(page);
    const sessionURL = `${isolatedServer.baseURL}/session?id=${encodeURIComponent(sessionId)}`;
    await page.goto(sessionURL);
    await waitForSessionReady(page);
    await expectSettledStreamCounts(request, isolatedServer);

    const draft = "  restart draft\nkeeps its trailing space  ";
    const textarea = page.locator("#pi-chat-message");
    await textarea.fill(draft);
    await expect(textarea).toHaveValue(draft);

    const before = await readCanonical(request, isolatedServer, sessionId);
    const beforeIds = canonicalIds(before);
    const beforeRenderedIds = await readRenderedIds(page);
    expectOrderedUnique(beforeIds);

    const marker = `RESTART_RECOVERY_${testInfo.workerIndex}_${Date.now()}`;
    const { id: markerId, entry } = assistantTextEntry(lastId, marker);
    await isolatedServer.restart(() => {
      appendEntry(isolatedServer.sessionsDir, name, entry);
    });

    await expect(page.locator(`#entry-${markerId}`)).toHaveCount(1, {
      timeout: 20_000,
    });
    expect(page.url()).toBe(sessionURL);
    await expect(textarea).toHaveValue(draft);

    const after = await readCanonical(request, isolatedServer, sessionId);
    const afterIds = canonicalIds(after);
    expect(afterIds).toEqual([...beforeIds, markerId]);
    expectOrderedUnique(afterIds);
    expect(afterIds.filter((id) => id === markerId)).toHaveLength(1);
    await expect(page.getByText(marker, { exact: true })).toHaveCount(1);

    const afterRenderedIds = await readRenderedIds(page);
    expect(afterRenderedIds).toEqual([...beforeRenderedIds, markerId]);
    expectOrderedUnique(afterRenderedIds);
    await expectSettledStreamCounts(request, isolatedServer);
  });

  test("failed send retains the exact draft and never replays before deliberate retry", async ({
    isolatedServer,
    page,
    request,
  }, testInfo) => {
    await configureIsolatedServer(request, isolatedServer);
    const cwd = realWorkingDir();
    try {
      const { entries } = buildSession({ cwd });
      const name = uniqueSessionName(testInfo, "resilience-send");
      const sessionId = writeSession(isolatedServer.sessionsDir, name, entries);

      await enableGlobalAndSessionStreams(page);
      await installFailedSendControl(page);
      await collapseRightSidebar(page);

      await page.goto(`${isolatedServer.baseURL}/session?id=${encodeURIComponent(sessionId)}`);
      await waitForSessionReady(page);
      await expectSettledStreamCounts(request, isolatedServer);

      const before = await readCanonical(request, isolatedServer, sessionId);
      const beforeIds = canonicalIds(before);
      const beforeRenderedIds = await readRenderedIds(page);
      const marker = `FAILED_SEND_${testInfo.workerIndex}_${Date.now()}`;
      const draft = `  ${marker}\nsecond line  \n`;
      const textarea = page.locator("#pi-chat-message");
      await textarea.fill(draft);
      await page.locator("#pi-chat-send").click();

      await expect(page.locator("#pi-chat-status")).toHaveText("simulated send failure");
      await expect(textarea).toHaveValue(draft);
      expect(await sendAttempts(page)).toBe(1);

      // A failed attempt is not queued for replay. Keep this bounded pause
      // longer than the connection's first reconnect delay and prove both the
      // request count and authoritative transcript remain unchanged.
      await page.waitForTimeout(1_250);
      expect(await sendAttempts(page)).toBe(1);
      const afterFailure = await readCanonical(request, isolatedServer, sessionId);
      expect(canonicalIds(afterFailure)).toEqual(beforeIds);
      expect(await readRenderedIds(page)).toEqual(beforeRenderedIds);
      await expect(textarea).toHaveValue(draft);

      // Retry is an explicit second click using the restored draft.
      await page.locator("#pi-chat-send").click();
      await expect.poll(() => sendAttempts(page), { timeout: 5_000 }).toBe(2);
      await expect(textarea).toHaveValue("");
      await expect
        .poll(
          async () => {
            const session = await readCanonical(request, isolatedServer, sessionId);
            return session.entries.filter(
              (entry) => entry.message?.role === "assistant" && entryText(entry).includes(marker),
            ).length;
          },
          { timeout: 20_000, intervals: [100, 200, 500] },
        )
        .toBe(1);

      const afterRetry = await readCanonical(request, isolatedServer, sessionId);
      const afterIds = canonicalIds(afterRetry);
      const newIds = afterIds.slice(beforeIds.length);
      expect(afterIds.slice(0, beforeIds.length)).toEqual(beforeIds);
      expect(newIds).toHaveLength(2);
      expectOrderedUnique(afterIds);
      expect(
        afterRetry.entries.filter(
          (entry) => entry.message?.role === "user" && entryText(entry).includes(marker),
        ),
      ).toHaveLength(1);
      expect(
        afterRetry.entries.filter(
          (entry) => entry.message?.role === "assistant" && entryText(entry).includes(marker),
        ),
      ).toHaveLength(1);

      await expect
        .poll(() => readRenderedIds(page), {
          timeout: 15_000,
          intervals: [100, 200, 500],
        })
        .toEqual([...beforeRenderedIds, ...newIds]);
      for (const id of newIds) {
        await expect(page.locator(`#entry-${id}`)).toHaveCount(1);
      }
      await expectSettledStreamCounts(request, isolatedServer);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
