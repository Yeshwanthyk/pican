/**
 * artifact-filter.js — pure, DOM-free filtering of artifact descriptors by the
 * user's Artifacts settings.
 *
 * The registry (artifact-registry.js) always detects *everything*; this module
 * narrows that list down to what the user wants to see:
 *
 *   - `enabled === false` → show nothing (the Artifacts pane hides itself).
 *   - empty `include` list → show everything (all files + chat snippets).
 *   - non-empty `include` list → keep file artifacts whose path matches a
 *     pattern, and DROP chat snippets (they have no path to match against).
 *
 * Patterns are simple globs, not gitignore syntax:
 *   - a pattern with no `/` matches the artifact's basename (`*.md`, `*.html`)
 *   - a pattern containing `/` matches the full path (`artifacts/**`, `docs/*.md`)
 *   - `*`  → any run of non-slash characters
 *   - `**` → any characters (including slashes)
 *   - a bare extension token (`.md`) is normalized to `*.md`
 *
 * Kept DOM-free and side-effect-free for isolated unit testing, mirroring
 * artifact-registry.js.
 */

const ENABLED_KEY = "pican:v1:artifacts:enabled";
const INCLUDE_KEY = "pican:v1:artifacts:include";

// localStorage keys that should re-run the filter when changed in another tab.
export const ARTIFACT_SETTING_KEYS = [ENABLED_KEY, INCLUDE_KEY];

// JS-side fallbacks so the session page can paint synchronously before the
// server-backed settings (hydrateSettings) resolve. Mirrors settingDefaults in
// internal/server/settings.go.
const DEFAULT_ENABLED = true;
const DEFAULT_INCLUDE = "*.md, *.html";

/** Split a raw include string into normalized glob patterns. */
export function parsePatterns(str: unknown): string[] {
  if (typeof str !== "string") return [];
  return str
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith(".") && !t.includes("/") ? `*${t}` : t));
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/** Compile one glob pattern to a RegExp anchored over the whole string. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
      } // ** → any chars
      else re += "[^/]*"; // *  → non-slash run
    } else {
      re += (ch ?? "").replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/** True if filePath matches any pattern (basename-scoped unless pattern has `/`). */
export function matchesPath(filePath: unknown, patterns: ReadonlyArray<string>): boolean {
  if (typeof filePath !== "string" || !filePath) return false;
  const base = basename(filePath);
  for (const pattern of patterns) {
    const target = pattern.includes("/") ? filePath : base;
    if (globToRegExp(pattern).test(target)) return true;
  }
  return false;
}

/**
 * Filter detected artifacts by the user's settings.
 * @returns {{visible: Array, hiddenCount: number}}
 */
export interface FilterableArtifact {
  readonly filePath?: string | null;
  readonly [key: string]: unknown;
}

export function filterArtifacts<Artifact extends FilterableArtifact>(
  artifacts: ReadonlyArray<Artifact> | null | undefined,
  { enabled = true, include = "" }: { readonly enabled?: boolean; readonly include?: string } = {},
): { visible: Artifact[]; hiddenCount: number } {
  const list = Array.isArray(artifacts) ? artifacts : [];
  if (enabled === false) return { visible: [], hiddenCount: 0 };

  const patterns = parsePatterns(include);
  if (patterns.length === 0) return { visible: list, hiddenCount: 0 };

  const visible = list.filter((a) => a && a.filePath && matchesPath(a.filePath, patterns));
  return { visible, hiddenCount: list.length - visible.length };
}

/**
 * Read the two artifact settings from storage with JS fallback defaults, so the
 * session page can filter synchronously on first paint.
 */
interface ArtifactStorage {
  getItem(key: string): string | null;
}

const readSetting = (storage: ArtifactStorage | null | undefined, key: string): string | null => {
  if (!storage) return null;
  return runSync(
    Effect.try({
      try: () => storage.getItem(key),
      catch: (cause) => new StorageError({ key, op: "read", cause }),
    }).pipe(Effect.catch(() => Effect.succeed(null))),
  );
};

export function readArtifactSettings(storage: ArtifactStorage | null | undefined): {
  enabled: boolean;
  include: string;
} {
  let enabled = DEFAULT_ENABLED;
  let include = DEFAULT_INCLUDE;
  const e = readSetting(storage, ENABLED_KEY);
  if (e != null) enabled = e === "true";
  const inc = readSetting(storage, INCLUDE_KEY);
  if (inc != null) include = inc;
  return { enabled, include };
}

export const __test__ = { globToRegExp, basename, DEFAULT_ENABLED, DEFAULT_INCLUDE };
import { Effect } from "effect";
import { StorageError } from "../../lib/errors";
import { runSync } from "../../lib/runtime";
