import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SERVER_SETTING_KEYS,
  configureSettingsSync,
  hydrateSettings,
  resetSettingsSyncForTests,
  writeSetting,
  writeSettings,
} from "./settings-store.js";

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    _map: map,
  };
}

afterEach(() => resetSettingsSyncForTests());

describe("writeSetting", () => {
  it("writes to localStorage without posting when sync is not configured", () => {
    const storage = fakeStorage();
    writeSetting("pican-theme", "nord", { storage });
    expect(storage.getItem("pican-theme")).toBe("nord");
  });

  it("posts a server-backed key through to /api/settings when sync is configured", () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: true }),
    );
    configureSettingsSync({ fetchImpl });
    writeSetting("pican-theme", "light", { storage });
    expect(storage.getItem("pican-theme")).toBe("light");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/settings");
    expect(options?.method).toBe("POST");
    expect(decodeJson(String(options?.body))).toEqual({ settings: { "pican-theme": "light" } });
  });

  it("does not post unknown keys", () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: true }),
    );
    configureSettingsSync({ fetchImpl });
    writeSetting("pican:v1:right-sidebar-width", "320", { storage });
    expect(storage.getItem("pican:v1:right-sidebar-width")).toBe("320");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("writeSettings", () => {
  it("batches server-backed keys into a single POST", () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve({ ok: true }),
    );
    configureSettingsSync({ fetchImpl });
    writeSettings({ "pican-theme": "dracula", "pican:spinner-style": "braille" }, { storage });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(decodeJson(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      settings: { "pican-theme": "dracula", "pican:spinner-style": "braille" },
    });
  });
});

describe("hydrateSettings", () => {
  it("seeds localStorage from the server response", async () => {
    const storage = fakeStorage();
    const settings: Record<string, string> = {};
    SERVER_SETTING_KEYS.forEach((key) => (settings[key] = "x"));
    settings["pican-theme"] = "nord";
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ settings }) }),
    );
    const result = await hydrateSettings({ fetchImpl, storage });
    expect(result?.["pican-theme"]).toBe("nord");
    expect(storage.getItem("pican-theme")).toBe("nord");
    expect(storage.getItem("pican:spinner-style")).toBe("x");
    expect(storage.getItem("pican:v1:session-tabs")).toBe("x");
  });

  it("returns null and leaves storage untouched on failure", async () => {
    const storage = fakeStorage();
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: false }));
    await expect(hydrateSettings({ fetchImpl, storage })).resolves.toBeNull();
    expect(storage._map.size).toBe(0);
  });

  it("no-ops without a fetch impl", async () => {
    const storage = fakeStorage();
    await expect(hydrateSettings({ fetchImpl: null, storage })).resolves.toBeNull();
  });
});
