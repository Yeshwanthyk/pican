let sessionPaletteApi = null;

export function setSessionPaletteApi(api = null) {
  sessionPaletteApi = api;
}

export function getSessionPaletteApi() {
  return sessionPaletteApi;
}

export function openSessionPalette() {
  return sessionPaletteApi?.open?.();
}

export function refreshSessionPalette() {
  return sessionPaletteApi?.refresh?.();
}
