// English UI string lookup shared by Svelte, vanilla-JS runtime code, and
// server-less exports. Keeping strings keyed avoids duplicating copy across
// renderers while keeping the application English-only.
import english from "./english.js";

const catalog: Readonly<Record<string, string>> = english;

export function t(key: string, params?: Readonly<Record<string, unknown>>): string {
  let value = catalog[key] ?? key;
  if (params && typeof value === "string") {
    value = value.replace(/\{(\w+)\}/g, (match, name) =>
      name in params ? String(params[name]) : match,
    );
  }
  return value;
}
