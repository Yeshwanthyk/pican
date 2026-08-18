import { Effect, Schema } from "effect";
import { NetworkError, StorageError } from "../lib/errors";
import { runFork, runPromise, runSync } from "../lib/runtime";
import { SettingsResponseSchema } from "../lib/schema";
import { withBasePath } from "./base-path";

export const SESSION_TABS_SETTING_KEY = "pican:v1:session-tabs";

export const SERVER_SETTING_KEYS = [
  "pican-theme",
  "pican:v1:font-ui",
  "pican:v1:font-content",
  "pican:v1:font-ui-size",
  "pican:v1:font-content-size",
  "pican:spinner-style",
  "pican:v1:notify-on-done",
  "pican:view-layout",
  "pican:v1:auto-title:enabled",
  "pican:v1:auto-title:mode",
  "pican:v1:auto-title:model",
  "pican:v1:artifacts:enabled",
  "pican:v1:artifacts:include",
  "pican:v1:toggle:thinking",
  "pican:v1:toggle:tools",
  "pican:v1:toggle:tool-outputs",
  SESSION_TABS_SETTING_KEY,
] as const;

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

interface SettingsResponseLike {
  readonly ok: boolean;
  json?(): Promise<unknown>;
}

export type SettingsFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<SettingsResponseLike>;

const SettingsRequestSchema = Schema.Struct({
  settings: Schema.Record(Schema.String, Schema.String),
});
const encodeSettingsRequest = Schema.encodeUnknownEffect(
  Schema.fromJsonString(SettingsRequestSchema),
);
const decodeSettingsResponse = Schema.decodeUnknownEffect(SettingsResponseSchema);

let syncFetch: SettingsFetch | null = null;

export function configureSettingsSync({ fetchImpl }: { readonly fetchImpl?: SettingsFetch } = {}) {
  syncFetch = fetchImpl ?? (typeof globalThis.fetch === "function" ? globalThis.fetch : null);
}

export function resetSettingsSyncForTests() {
  syncFetch = null;
}

const defaultStorage = (): SettingsStorage | null =>
  runSync(
    Effect.try({
      try: () => globalThis.localStorage,
      catch: (cause) => new StorageError({ key: "localStorage", op: "read", cause }),
    }).pipe(Effect.catch(() => Effect.succeed(null))),
  );

const postSettings = (settings: Readonly<Record<string, string>>) => {
  const fetchImpl = syncFetch;
  if (fetchImpl === null) return;
  const body = runSync(
    encodeSettingsRequest({ settings }).pipe(Effect.catch(() => Effect.succeed(undefined))),
  );
  if (body === undefined) return;
  const pending = runSync(
    Effect.try({
      try: () =>
        fetchImpl(withBasePath("/api/settings"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body,
        }),
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(Effect.catch(() => Effect.succeed(undefined))),
  );
  if (pending === undefined) return;
  runFork(
    Effect.tryPromise({
      try: () => pending,
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(Effect.catch(() => Effect.void)),
  );
};

const writeLocal = (storage: SettingsStorage | null, key: string, value: string) => {
  runSync(
    Effect.try({
      try: () => storage?.setItem(key, value),
      catch: (cause) => new StorageError({ key, op: "write", cause }),
    }).pipe(Effect.catch(() => Effect.void)),
  );
};

export function writeSetting(
  key: string,
  value: unknown,
  { storage = defaultStorage() }: { readonly storage?: SettingsStorage | null } = {},
) {
  const stringValue = String(value);
  writeLocal(storage, key, stringValue);
  if (SERVER_SETTING_KEYS.includes(key as (typeof SERVER_SETTING_KEYS)[number])) {
    postSettings({ [key]: stringValue });
  }
}

export function writeSettings(
  values: Readonly<Record<string, unknown>> | null | undefined,
  { storage = defaultStorage() }: { readonly storage?: SettingsStorage | null } = {},
) {
  const toSync: Record<string, string> = {};
  Object.entries(values ?? {}).forEach(([key, value]) => {
    const stringValue = String(value);
    writeLocal(storage, key, stringValue);
    if (SERVER_SETTING_KEYS.includes(key as (typeof SERVER_SETTING_KEYS)[number])) {
      toSync[key] = stringValue;
    }
  });
  if (Object.keys(toSync).length > 0) postSettings(toSync);
}

const hydrateEffect = Effect.fnUntraced(function* (
  fetchImpl: SettingsFetch,
  storage: SettingsStorage | null,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetchImpl(withBasePath("/api/settings"), { headers: { Accept: "application/json" } }),
    catch: (cause) => new NetworkError({ cause }),
  });
  if (!response.ok || response.json === undefined) return null;
  const payload = yield* Effect.tryPromise({
    try: () => response.json?.() ?? Promise.resolve(undefined),
    catch: (cause) => new NetworkError({ cause }),
  });
  const { settings } = yield* decodeSettingsResponse(payload);
  yield* Effect.forEach(SERVER_SETTING_KEYS, (key) => {
    const value = settings[key];
    if (value === undefined || value === null) return Effect.void;
    return Effect.try({
      try: () => storage?.setItem(key, value),
      catch: (cause) => new StorageError({ key, op: "write", cause }),
    }).pipe(Effect.catch(() => Effect.void));
  });
  return settings;
});

export function hydrateSettings({
  fetchImpl = syncFetch,
  storage = defaultStorage(),
}: {
  readonly fetchImpl?: SettingsFetch | null;
  readonly storage?: SettingsStorage | null;
} = {}): Promise<Readonly<Record<string, string | null>> | null> {
  if (fetchImpl === null) return Promise.resolve(null);
  return runPromise(
    hydrateEffect(fetchImpl, storage).pipe(Effect.catch(() => Effect.succeed(null))),
  );
}
