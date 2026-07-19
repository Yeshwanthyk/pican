import { writeSetting } from "./settings-store.js";
import { setThemeIconElement } from "./icons.js";

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

function readThemeColor(windowImpl, documentImpl, property) {
  try {
    const cs = windowImpl.getComputedStyle(documentImpl.documentElement);
    return cs.getPropertyValue(property).trim() || "";
  } catch (e) {
    return "";
  }
}

export function applyTheme(windowImpl, documentImpl, next) {
  next = next || "dark";
  documentImpl.documentElement.dataset.theme = next;
  writeSetting("pican-theme", next, { storage: windowImpl.localStorage });
  try {
    documentImpl.cookie = "pican-theme=" + next + ";path=/;SameSite=Lax;max-age=31536000";
  } catch (e) {}

  const wco = !!(
    windowImpl.navigator &&
    windowImpl.navigator.windowControlsOverlay &&
    windowImpl.navigator.windowControlsOverlay.visible
  );
  // theme.css is the sole palette owner. Reading the active CSS variable here
  // keeps built-in, community, and user-defined custom themes on one path.
  const color =
    readThemeColor(windowImpl, documentImpl, wco ? "--chrome-bg" : "--body-bg") || DARK_BODY_BG;
  try {
    documentImpl.documentElement.style.backgroundColor = color;
  } catch (e) {}
  const meta = documentImpl.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = color;
}

export function toggleTheme(windowImpl, documentImpl) {
  const current = documentImpl.documentElement.dataset.theme || "dark";
  const idx = THEME_IDS.indexOf(current);
  const next = idx === -1 ? THEME_IDS[0] : THEME_IDS[(idx + 1) % THEME_IDS.length];
  applyTheme(windowImpl, documentImpl, next);
}

export function syncThemeIcons(documentImpl) {
  const current = documentImpl.documentElement.dataset.theme || "dark";
  documentImpl.querySelectorAll("[data-command-theme-icon]").forEach((el) => {
    setThemeIconElement(el, current, { documentImpl });
  });
  documentImpl.querySelectorAll("[data-theme-icon]").forEach((el) => {
    setThemeIconElement(el, current, { documentImpl });
  });
}
