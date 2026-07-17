function parseJSON(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function normalizeRunning(payload) {
  if (!Array.isArray(payload?.running)) return null;
  return {
    ids: payload.running,
    statuses: payload.statuses && typeof payload.statuses === 'object' ? payload.statuses : {},
  };
}

function normalizeDelta(payload) {
  if (!payload || typeof payload.id !== 'string') return null;
  return {
    id: payload.id,
    running: !!payload.running,
    model: typeof payload.model === 'string' ? payload.model : '',
    modelName: typeof payload.modelName === 'string' ? payload.modelName : '',
    modelProvider: typeof payload.modelProvider === 'string' ? payload.modelProvider : '',
  };
}

export function createStatusEvents({
  topic = '__all__',
  EventSourceImpl = globalThis.EventSource,
  windowImpl = globalThis.window,
  onSnapshot = () => {},
  onDelta = () => {},
  onMessage = () => {},
} = {}) {
  let stream = null;
  let pagehideHandler = null;
  let pageshowHandler = null;

  function closeStream() {
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  function cleanup() {
    closeStream();
    if (pagehideHandler && windowImpl?.removeEventListener) {
      windowImpl.removeEventListener('pagehide', pagehideHandler);
      pagehideHandler = null;
    }
    if (pageshowHandler && windowImpl?.removeEventListener) {
      windowImpl.removeEventListener('pageshow', pageshowHandler);
      pageshowHandler = null;
    }
  }

  function connect() {
    if (!EventSourceImpl) return;
    cleanup();
    const es = new EventSourceImpl(`/events?id=${encodeURIComponent(topic)}`);
    stream = es;

    es.onmessage = (event) => onMessage(event.data);
    es.addEventListener('status-snapshot', (event) => {
      const snapshot = normalizeRunning(parseJSON(event.data));
      if (snapshot) onSnapshot(snapshot);
    });
    es.addEventListener('status-delta', (event) => {
      const delta = normalizeDelta(parseJSON(event.data));
      if (delta) onDelta(delta);
    });

    if (windowImpl?.addEventListener) {
      // `beforeunload` makes back/forward navigation less smooth in several
      // browsers because it can disable the bfcache. `pagehide` still lets us
      // close the SSE stream without opting the page out of page cache.
      pagehideHandler = () => closeStream();
      pageshowHandler = () => {
        if (!stream) connect();
      };
      windowImpl.addEventListener('pagehide', pagehideHandler);
      windowImpl.addEventListener('pageshow', pageshowHandler);
    }
  }

  return { connect, cleanup };
}
