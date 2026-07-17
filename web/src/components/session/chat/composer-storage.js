export function getComposerStorage({ windowImpl = window } = {}) {
  try {
    return windowImpl.localStorage;
  } catch {
    return null;
  }
}
