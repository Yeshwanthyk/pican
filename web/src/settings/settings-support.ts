import { Effect } from "effect";
import { StorageError } from "../lib/errors";
import type { ModelList } from "../lib/schema";
import { runPromise, runSync } from "../lib/runtime";
import { effects } from "../shared/api";
import { configureSettingsSync, hydrateSettings, writeSetting } from "../shared/settings-store";
import type { SettingsFetch, SettingsStorage } from "../shared/settings-store";

export type Settings = Readonly<Record<string, string | null | undefined>>;

interface SettingsWindow {
  readonly fetch?: SettingsFetch;
  readonly localStorage?: SettingsStorage;
}

interface StorageOptions {
  readonly storage?: SettingsStorage | null;
}

export interface ModelOption {
  readonly id: string;
  readonly name: string;
  readonly value: string;
}

export interface ModelGroup {
  readonly provider: string;
  readonly models: ReadonlyArray<ModelOption>;
}

export async function loadSettings({
  windowImpl = window,
}: { readonly windowImpl?: SettingsWindow } = {}) {
  const fetchImpl = windowImpl.fetch?.bind(windowImpl);
  configureSettingsSync({ fetchImpl });
  return (await hydrateSettings({ fetchImpl, storage: windowImpl.localStorage })) || {};
}

const readStored = (storage: SettingsStorage | null, key: string): string | null =>
  runSync(
    Effect.try({
      try: () => storage?.getItem(key) ?? null,
      catch: (cause) => new StorageError({ key, op: "read", cause }),
    }).pipe(Effect.catch(() => Effect.succeed(null))),
  );

export function valueFor(
  settings: Settings | null | undefined,
  key: string,
  fallback = "",
  { storage = globalThis.localStorage }: StorageOptions = {},
): string {
  const value = settings?.[key];
  if (value !== undefined && value !== null) return value;
  return readStored(storage, key) ?? fallback;
}

export function boolFor(
  settings: Settings | null | undefined,
  key: string,
  fallback = false,
  options: StorageOptions = {},
): boolean {
  return valueFor(settings, key, fallback ? "true" : "false", options) === "true";
}

export function persistSetting(
  key: string,
  value: unknown,
  { storage = globalThis.localStorage }: StorageOptions = {},
) {
  writeSetting(key, value, { storage });
}

const modelGroups = (models: ModelList["models"]): ReadonlyArray<ModelGroup> => {
  const byProvider = new Map<string, Array<ModelOption>>();
  models.forEach((model) => {
    const id = model.id || model.modelId || "";
    const provider = model.provider || "";
    if (!id || !provider) return;
    const options = byProvider.get(provider) ?? [];
    options.push({ id, name: model.name || id, value: `${provider}/${id}` });
    byProvider.set(provider, options);
  });
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, models]) => ({ provider, models }));
};

export function fetchModelGroups(): Promise<ReadonlyArray<ModelGroup>> {
  return runPromise(
    effects.models.pipe(
      Effect.map(({ models }) => modelGroups(models)),
      Effect.catch(() => Effect.succeed([])),
    ),
  );
}
