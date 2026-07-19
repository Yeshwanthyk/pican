import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

interface ClientLike {
  readonly visibilityState?: string;
  readonly focused?: boolean;
  readonly url: string;
}

interface WorkerEvent {
  readonly data?: { json(): unknown };
  readonly notification?: { close(): void; readonly data?: { readonly sessionId?: string } };
  waitUntil?(promise: Promise<unknown>): void;
}

type WorkerHandler = (event: WorkerEvent) => void;

function loadServiceWorker({ clients = [] }: { readonly clients?: ClientLike[] } = {}) {
  const listeners: Record<string, WorkerHandler> = {};
  const notifications: Array<{ title: string; options: unknown }> = [];
  const badgeSet: number[] = [];
  const badge = { set: badgeSet, cleared: 0 };
  const self = {
    addEventListener(type: string, handler: WorkerHandler) {
      listeners[type] = handler;
    },
    skipWaiting() {},
    navigator: {
      setAppBadge: async (n: number) => {
        badge.set.push(n);
      },
      clearAppBadge: async () => {
        badge.cleared += 1;
      },
    },
    clients: {
      claim() {},
      matchAll: async () => clients,
      openWindow: async () => null,
    },
    registration: {
      showNotification: async (title: string, options: unknown) => {
        notifications.push({ title, options });
      },
    },
  };
  const code = readFileSync(resolve(process.cwd(), "../internal/ui/embedded/assets/sw.js"), "utf8");
  vm.runInNewContext(code, { self }, { filename: "internal/ui/embedded/assets/sw.js" });
  return { listeners, notifications, badge };
}

async function dispatchPush(
  listener: WorkerHandler | undefined,
  payload: unknown = { title: "pi session", body: "Response ready", sessionId: "s1" },
): Promise<void> {
  if (!listener) return;
  const waits: Promise<unknown>[] = [];
  listener({
    data: { json: () => payload },
    waitUntil: (promise: Promise<unknown>) => {
      waits.push(promise);
    },
  });
  await Promise.all(waits);
}

describe("push service worker notifications", () => {
  it("suppresses system push notifications while an app window is visible", async () => {
    const { listeners, notifications } = loadServiceWorker({
      clients: [{ visibilityState: "visible", url: "http://localhost/session?id=s1" }],
    });

    await dispatchPush(listeners.push);

    expect(notifications).toEqual([]);
  });

  it("suppresses system push notifications while an app window is focused", async () => {
    const { listeners, notifications } = loadServiceWorker({
      clients: [{ focused: true, url: "http://localhost/session?id=s1" }],
    });

    await dispatchPush(listeners.push);

    expect(notifications).toEqual([]);
  });

  it("shows system push notifications when the app is backgrounded or locked", async () => {
    const { listeners, notifications } = loadServiceWorker({
      clients: [{ visibilityState: "hidden", url: "http://localhost/session?id=s1" }],
    });

    await dispatchPush(listeners.push);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: "pi session",
      options: { body: "Response ready", silent: false, data: { sessionId: "s1" } },
    });
  });

  it("shows system push notifications when the app is closed", async () => {
    const { listeners, notifications } = loadServiceWorker({ clients: [] });

    await dispatchPush(listeners.push);

    expect(notifications).toHaveLength(1);
  });

  it("sets an app-icon badge when showing a background notification", async () => {
    const { listeners, badge } = loadServiceWorker({ clients: [] });

    await dispatchPush(listeners.push);

    expect(badge.set).toEqual([1]);
  });

  it("does not badge when a foreground window suppresses the notification", async () => {
    const { listeners, badge } = loadServiceWorker({
      clients: [{ visibilityState: "visible", url: "http://localhost/session?id=s1" }],
    });

    await dispatchPush(listeners.push);

    expect(badge.set).toEqual([]);
  });

  it("clears the app-icon badge when a notification is clicked", async () => {
    const { listeners, badge } = loadServiceWorker({ clients: [] });

    const waits: Promise<unknown>[] = [];
    listeners.notificationclick?.({
      notification: { close() {}, data: { sessionId: "s1" } },
      waitUntil: (promise: Promise<unknown>) => {
        waits.push(promise);
      },
    });
    await Promise.all(waits);

    expect(badge.cleared).toBe(1);
  });
});
