import { Effect } from "effect";
import { runSync } from "../lib/runtime";
import { setThemeIconElement } from "./icons.js";
import { writeSetting } from "./settings-store.js";
import type { SettingsStorage } from "./settings-store.js";

export const BUILTIN_THEME_IDS = ["dark", "light", "nord", "dracula", "custom"];
export const COMMUNITY_THEME_IDS = [
  "catppuccin-mocha",
  "catppuccin-latte",
  "gruvbox-dark",
  "tokyo-night",
  "rose-pine",
  "github-dark",
  "github-light",
  "one-dark-pro",
  "everforest-dark",
  "kanagawa-wave",
];
export const THEME_IDS = [...BUILTIN_THEME_IDS, ...COMMUNITY_THEME_IDS];

const DARK_BODY_BG = "#111116";

interface ThemeElement {
  content?: string;
  readonly dataset?: Record<string, string | undefined>;
  readonly style?: { backgroundColor?: string };
}

interface ThemeDocument {
  cookie: string;
  readonly documentElement: ThemeElement & {
    readonly dataset: Record<string, string | undefined>;
    readonly style: { backgroundColor?: string };
  };
  querySelector(selector: string): ThemeElement | null;
  querySelectorAll?(selector: string): { forEach(callback: (element: Element) => void): void };
}

interface ThemeWindow {
  readonly localStorage?: SettingsStorage;
  readonly navigator?: { readonly windowControlsOverlay?: { readonly visible?: boolean } };
  getComputedStyle?(element: ThemeElement): { getPropertyValue(property: string): string };
}

const bestEffort = <A>(operation: () => A, fallback: A): A =>
  runSync(
    Effect.try({ try: operation, catch: (cause) => cause }).pipe(
      Effect.catch(() => Effect.succeed(fallback)),
    ),
  );

function readThemeColor(
  windowImpl: ThemeWindow,
  documentImpl: ThemeDocument,
  property: string,
): string {
  return bestEffort(
    () =>
      windowImpl
        .getComputedStyle?.(documentImpl.documentElement)
        .getPropertyValue(property)
        .trim() ?? "",
    "",
  );
}

export function applyTheme(
  windowImpl: ThemeWindow,
  documentImpl: ThemeDocument,
  requested: string | null | undefined,
): void {
  const next = requested || "dark";
  documentImpl.documentElement.dataset.theme = next;
  writeSetting("pican-theme", next, { storage: windowImpl.localStorage });
  bestEffort(() => {
    documentImpl.cookie = `pican-theme=${next};path=/;SameSite=Lax;max-age=31536000`;
  }, undefined);

  const overlay = Boolean(windowImpl.navigator?.windowControlsOverlay?.visible);
  const color =
    readThemeColor(windowImpl, documentImpl, overlay ? "--chrome-bg" : "--body-bg") || DARK_BODY_BG;
  bestEffort(() => {
    documentImpl.documentElement.style.backgroundColor = color;
  }, undefined);
  const meta = documentImpl.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = color;
}

export function toggleTheme(windowImpl: ThemeWindow, documentImpl: ThemeDocument): void {
  const current = documentImpl.documentElement.dataset.theme || "dark";
  const index = THEME_IDS.indexOf(current);
  const next = index === -1 ? THEME_IDS[0] : THEME_IDS[(index + 1) % THEME_IDS.length];
  applyTheme(windowImpl, documentImpl, next);
}

export function syncThemeIcons(documentImpl: Document): void {
  const current = documentImpl.documentElement.dataset.theme || "dark";
  documentImpl.querySelectorAll("[data-command-theme-icon]").forEach((element) => {
    setThemeIconElement(element, current, { documentImpl });
  });
  documentImpl.querySelectorAll("[data-theme-icon]").forEach((element) => {
    setThemeIconElement(element, current, { documentImpl });
  });
}
