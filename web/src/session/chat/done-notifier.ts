import { Effect, Schema } from "effect";
import { DecodeError, NetworkError, StorageError } from "../../lib/errors";
import type { FetchLike } from "../../lib/http";
import { runFork, runPromise, runSync } from "../../lib/runtime";
import { writeSetting } from "../../shared/settings-store.js";
import type { SettingsStorage } from "../../shared/settings-store.js";
import { withBasePath } from "../../shared/base-path.js";

interface NotificationLike {
  onclick: ((event: Event) => unknown) | null;
  close(): void;
}

interface NotificationConstructor {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: NotificationOptions): NotificationLike;
}

interface BadgeNavigator {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
  serviceWorker?: ServiceWorkerContainer;
}

interface DoneWindow {
  readonly Notification?: NotificationConstructor | null;
  readonly navigator: BadgeNavigator;
  readonly PushManager?: unknown;
  readonly console?: Pick<Console, "warn">;
  focus?(): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface VisibilityDocument {
  hidden: boolean;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
}

interface StorageOptions {
  readonly storage?: SettingsStorage;
}

interface WindowOptions {
  readonly windowImpl?: DoneWindow;
}

const bestEffort = <A>(operation: () => A, fallback: A): A =>
  runSync(
    Effect.try({
      try: operation,
      catch: (cause) => new StorageError({ key: "browser-api", op: "read", cause }),
    }).pipe(Effect.catch(() => Effect.succeed(fallback))),
  );

const ignorePromise = (operation: () => Promise<unknown>): void => {
  runFork(
    Effect.tryPromise({ try: operation, catch: (cause) => new NetworkError({ cause }) }).pipe(
      Effect.catch(() => Effect.void),
    ),
  );
};

const VapidResponseSchema = Schema.Struct({ publicKey: Schema.String });
const encodeJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const isNetworkError = Schema.is(NetworkError);

const responseText = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new NetworkError({ cause }),
  });

const decodeResponse = <A, R>(
  response: Response,
  schema: Schema.ConstraintDecoder<A, R>,
): Effect.Effect<A, NetworkError | DecodeError, R> =>
  responseText(response).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError((error) =>
      isNetworkError(error)
        ? error
        : new DecodeError({ url: response.url, issue: "invalid response" }),
    ),
  );

export const DONE_NOTIFY_STORAGE_KEY = "pican:v1:notify-on-done";
export function isDoneNotifyEnabled({

  storage = globalThis.localStorage,
}: StorageOptions = {}): boolean {
  return bestEffort(() => storage?.getItem(DONE_NOTIFY_STORAGE_KEY) === "true", false);
}

export function setDoneNotifyEnabled(
  enabled: boolean,
  { storage = globalThis.localStorage }: StorageOptions = {},
): void {
  writeSetting(DONE_NOTIFY_STORAGE_KEY, String(!!enabled), { storage });
}

export function showDoneNotification({
  windowImpl = globalThis.window,
  documentImpl = globalThis.document,
  title = "pican session",
  body = "Response ready",
}: WindowOptions & {
  readonly documentImpl?: VisibilityDocument;
  readonly title?: string;
  readonly body?: string;
} = {}): void {
  bestEffort(() => {
    const N = windowImpl.Notification;
    if (!N || N.permission !== "granted") return;
    if (!documentImpl.hidden) return;
    const n = new N(title, {
      body,
      icon: withBasePath("/app-icon.png"),
      tag: "pican-session-done",
    });
    n.onclick = () => {
      bestEffort(() => windowImpl.focus?.(), undefined);
      n.close();
    };
  }, undefined);
}

export function requestNotifyPermission({
  windowImpl = globalThis.window,
}: WindowOptions = {}): Promise<NotificationPermission> {
  const N = windowImpl.Notification;
  if (!N) return Promise.resolve("denied");
  if (N.permission === "granted" || N.permission === "denied") return Promise.resolve(N.permission);
  return runPromise(
    Effect.tryPromise({
      try: () => N.requestPermission(),
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(Effect.catch(() => Effect.succeed("denied" as const))),
  );
}

// Decodes the URL-safe base64 VAPID key the server returns into the
// Uint8Array PushManager.subscribe expects.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Calls pushManager.subscribe(). If it throws (e.g. stale/incompatible
// subscription left over from a VAPID key rotation), force-unsubscribes the
// stale entry and retries once before giving up.
async function _subscribePush(
  reg: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription> {
  const opts = { userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) };
  const subscribe = Effect.tryPromise({
    try: () => reg.pushManager.subscribe(opts),
    catch: (cause) => new NetworkError({ cause }),
  });
  const operation = subscribe.pipe(
    Effect.catch(() =>
      Effect.tryPromise({
        try: () => reg.pushManager.getSubscription(),
        catch: (cause) => new NetworkError({ cause }),
      }).pipe(
        Effect.flatMap((stale) =>
          stale
            ? Effect.tryPromise({
                try: () => stale.unsubscribe(),
                catch: (cause) => new NetworkError({ cause }),
              }).pipe(
                Effect.catch(() => Effect.succeed(false)),
                Effect.andThen(subscribe),
              )
            : subscribe,
        ),
      ),
    ),
  );
  return runPromise(operation);
}

export async function registerPushSubscription({
  windowImpl = globalThis.window,
  fetchImpl = globalThis.fetch,
}: WindowOptions & { readonly fetchImpl?: FetchLike } = {}): Promise<boolean> {
  const navImpl = windowImpl.navigator;
  const serviceWorker = navImpl.serviceWorker;
  if (!serviceWorker || !windowImpl.PushManager) return false;
  const operation = Effect.gen(function* () {
    const reg = yield* Effect.tryPromise({
      try: () => serviceWorker.ready,
      catch: (cause) => new NetworkError({ cause }),
    });
    const keyResp = yield* Effect.tryPromise({
      try: () => fetchImpl(withBasePath("/api/push/vapid")),
      catch: (cause) => new NetworkError({ cause }),
    });
    if (!keyResp.ok) return false;
    const { publicKey } = yield* decodeResponse(keyResp, VapidResponseSchema);
    let sub = yield* Effect.tryPromise({
      try: () => reg.pushManager.getSubscription(),
      catch: (cause) => new NetworkError({ cause }),
    });
    if (!sub) {
      sub = yield* Effect.tryPromise({
        try: () => _subscribePush(reg, publicKey),
        catch: (cause) => new NetworkError({ cause }),
      });
    }
    const body = yield* encodeJson(sub.toJSON ? sub.toJSON() : sub).pipe(
      Effect.mapError(
        () => new DecodeError({ url: "/api/push/subscribe", issue: "encode failed" }),
      ),
    );
    yield* Effect.tryPromise({
      try: () =>
        fetchImpl(withBasePath("/api/push/subscribe"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      catch: (cause) => new NetworkError({ cause }),
    });
    return true;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        bestEffort(() => windowImpl.console?.warn("push subscribe failed", error), undefined);
        return false;
      }),
    ),
  );
  return runPromise(operation);
}

export async function unregisterPushSubscription({
  windowImpl = globalThis.window,
  fetchImpl = globalThis.fetch,
}: WindowOptions & { readonly fetchImpl?: FetchLike } = {}): Promise<void> {
  const serviceWorker = windowImpl.navigator.serviceWorker;
  if (!serviceWorker) return;
  const operation = Effect.gen(function* () {
    const reg = yield* Effect.tryPromise({
      try: () => serviceWorker.ready,
      catch: (cause) => new NetworkError({ cause }),
    });
    const sub = yield* Effect.tryPromise({
      try: () => reg.pushManager.getSubscription(),
      catch: (cause) => new NetworkError({ cause }),
    });
    if (!sub) return;
    yield* Effect.tryPromise({
      try: () => sub.unsubscribe(),
      catch: (cause) => new NetworkError({ cause }),
    });
    const body = yield* encodeJson({ endpoint: sub.endpoint }).pipe(
      Effect.mapError(
        () => new DecodeError({ url: "/api/push/unsubscribe", issue: "encode failed" }),
      ),
    );
    yield* Effect.tryPromise({
      try: () =>
        fetchImpl(withBasePath("/api/push/unsubscribe"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      catch: (cause) => new NetworkError({ cause }),
    });
  }).pipe(Effect.catch(() => Effect.void));
  await runPromise(operation);
}

export function setupDoneNotifyToggle({
  documentImpl = globalThis.document,
  windowImpl = globalThis.window,
  storage = globalThis.localStorage,
  fetchImpl = typeof globalThis.fetch !== "undefined" ? globalThis.fetch : null,
}: {
  readonly documentImpl?: Document;
  readonly windowImpl?: DoneWindow;
  readonly storage?: SettingsStorage;
  readonly fetchImpl?: FetchLike | null;
} = {}): () => void {
  const btn = documentImpl.getElementById("notify-toggle");
  if (!btn) return () => undefined;
  let disposed = false;

  const render = () => {
    if (disposed) return;
    const enabled = isDoneNotifyEnabled({ storage });
    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
    btn.classList.toggle("active", enabled);
    btn.title = enabled ? "Disable done notifications" : "Notify when response is ready";
    const span = btn.querySelector("span");
    if (span) span.textContent = enabled ? "◉" : "◌";
  };

  render();

  // If the user previously enabled notifications, make sure the push
  // subscription is registered on this device (it may be a new browser,
  // or the SW may have been reset). Cheap to call when already subscribed.
  if (isDoneNotifyEnabled({ storage }) && fetchImpl) {
    registerPushSubscription({ windowImpl, fetchImpl });
  }

  const onClick = async (): Promise<void> => {
    const enabled = isDoneNotifyEnabled({ storage });
    if (enabled) {
      setDoneNotifyEnabled(false, { storage });
      if (fetchImpl) unregisterPushSubscription({ windowImpl, fetchImpl });
      render();
      return;
    }
    const permission = await requestNotifyPermission({ windowImpl });
    const granted = permission === "granted";
    setDoneNotifyEnabled(granted, { storage });
    if (granted && fetchImpl) {
      await registerPushSubscription({ windowImpl, fetchImpl });
    }
    render();
  };
  btn.addEventListener("click", onClick);

  return () => {
    if (disposed) return;
    disposed = true;
    btn.removeEventListener("click", onClick);
  };
}

export function notifyDone({
  windowImpl = globalThis.window,
  documentImpl = globalThis.document,
  storage = globalThis.localStorage,
}: WindowOptions & StorageOptions & { readonly documentImpl?: VisibilityDocument } = {}): void {
  if (!isDoneNotifyEnabled({ storage })) return;
  showDoneNotification({ windowImpl, documentImpl });
  // Badge only when the user isn't watching this session — covers background
  // tabs, minimized windows, and other apps in front. Cleared on
  // visibilitychange/focus via setupAppBadgeClearing.
  if (documentImpl.hidden) {
    const setBadge = windowImpl.navigator.setAppBadge;
    if (setBadge) ignorePromise(() => setBadge.call(windowImpl.navigator, 1));
  }
}

// Clears the app-icon badge set by the service worker on a background push.
// No-op where the Badging API is unsupported.
export function clearAppBadge({ windowImpl = globalThis.window }: WindowOptions = {}): void {
  const clearBadge = windowImpl.navigator.clearAppBadge;
  if (clearBadge) ignorePromise(() => clearBadge.call(windowImpl.navigator));
}

// Clears the badge whenever the app comes to the foreground, so the user
// doesn't see a stale count after opening it directly (rather than via the
// notification tap, which the service worker handles).
export function setupAppBadgeClearing({
  documentImpl = globalThis.document,
  windowImpl = globalThis.window,
}: WindowOptions & { readonly documentImpl?: VisibilityDocument } = {}): () => void {
  let disposed = false;
  const clear = () => {
    if (!documentImpl.hidden) clearAppBadge({ windowImpl });
  };
  clear();
  documentImpl.addEventListener?.("visibilitychange", clear);
  windowImpl.addEventListener("focus", clear);
  return () => {
    if (disposed) return;
    disposed = true;
    documentImpl.removeEventListener?.("visibilitychange", clear);
    windowImpl.removeEventListener("focus", clear);
  };
}

