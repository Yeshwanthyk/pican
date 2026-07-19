// English UI string lookup shared by Svelte, vanilla-JS runtime code, and
// server-less exports. Keeping strings keyed avoids duplicating copy across
// renderers while keeping the application English-only.
import english from './english.js';

export function t(key, params) {
  let value = key in english ? english[key] : key;
  if (params && typeof value === 'string') {
    value = value.replace(/\{(\w+)\}/g, (match, name) =>
      name in params ? String(params[name]) : match,
    );
  }
  return value;
}
