export interface SessionPaletteApi {
  open?(): unknown;
  refresh?(): unknown;
}

let sessionPaletteApi: SessionPaletteApi | null = null;

export function setSessionPaletteApi(api: SessionPaletteApi | null = null): void {
  sessionPaletteApi = api;
}

export function getSessionPaletteApi(): SessionPaletteApi | null {
  return sessionPaletteApi;
}

export function openSessionPalette() {
  return sessionPaletteApi?.open?.();
}

export function refreshSessionPalette() {
  return sessionPaletteApi?.refresh?.();
}
