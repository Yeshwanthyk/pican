export function getSessionIdFromLocation({ locationImpl = location } = {}) {
  return locationImpl.search.split('id=')[1]?.split('&')[0] || '';
}

export function createSessionEventSource(sessionId, { EventSourceImpl = EventSource } = {}) {
  return new EventSourceImpl('/events?id=' + encodeURIComponent(sessionId));
}

export async function handleSessionReload({
  sessionId,
  fetchImpl = fetch,
  entryState,
  clearChatPreview = () => {},
  appendEntry,
  upsertEntry,
  refreshEntriesAffectedByToolResult,
  updateStats = () => {},
  updateTitle = () => {},
  isFollowing = () => false,
  isAtBottom = () => false,
  scrollAfterLayout = () => {},
  incrementPending = () => {},
  showFollowButton = () => {},
  onReloaded = () => {},
  onNewEntries = null,
  getEntryCount = null,
} = {}) {
  // getEntryCount is a live getter into the canonical entry count (typically
  // model.entries.length), not a value snapshotted once — reading it fresh
  // here keeps this correct even if something else (e.g. LoadEarlier
  // prepending older entries) changed the model between reloads. It should
  // return null/undefined when a from-0 count isn't meaningful (e.g. a
  // tail-windowed/paginated large session), which disables the delta request.
  const afterCount = typeof getEntryCount === 'function' ? getEntryCount() : null;
  const hasValidAfterCount = typeof afterCount === 'number' && afterCount >= 0;
  let url = '/api/session?id=' + encodeURIComponent(sessionId);
  if (hasValidAfterCount) {
    url += '&afterCount=' + afterCount;
  }
  const response = await fetchImpl(url);
  const data = await response.json();
  const entries = data.entries || [];
  const isDelta = hasValidAfterCount && data.deltaOk === true;
  onReloaded({ ...data, entries, isDelta });
  if (typeof data.name === 'string' && data.name.trim()) {
    updateTitle(data.name);
  }
  let newCount = 0;

  // Two modes:
  //  • Imperative (appendEntry provided): patch #messages DOM directly. Kept
  //    for isolated helper tests and non-Svelte callers.
  //  • Reactive (no appendEntry): the Svelte <SessionContent> owns #messages and
  //    re-renders from the model that onReloaded just updated, so here we only
  //    track which ids are brand-new (for follow/scroll/highlight decisions).
  const reactive = typeof appendEntry !== 'function';
  const newIds = [];

  entries.forEach((entry) => {
    if (!entry.id) return;
    if (reactive) {
      if (!entryState.seen.has(entry.id)) {
        entryState.seen.add(entry.id);
        newCount++;
        newIds.push(entry.id);
      }
      return;
    }
    if (!entryState.seen.has(entry.id)) {
      if (appendEntry(entry, entries)) newCount++;
      if (entry.message && entry.message.role === 'toolResult') {
        refreshEntriesAffectedByToolResult(entry, entries);
      }
    } else if (entryState.liveRendered.has(entry.id)) {
      upsertEntry(entry, entries);
      if (entry.message && entry.message.role === 'toolResult') {
        refreshEntriesAffectedByToolResult(entry, entries);
      }
    } else if (entry.message && entry.message.role === 'toolResult') {
      refreshEntriesAffectedByToolResult(entry, entries);
    }
  });

  // Clear optimistic pending user/assistant preview only after canonical
  // entries have been appended/upserted (imperative) or merged into the model
  // (reactive). Clearing earlier creates a visible blank/flicker when a cold
  // worker finally writes the real message.
  clearChatPreview();

  if (newCount > 0) {
    updateStats(entries);
    // Decide on the live scroll position, not just the cached follow flag: the
    // viewport can be pinned to the bottom while `following` is momentarily
    // stale, in which case showing the button would be wrong.
    if (isFollowing() || isAtBottom()) {
      scrollAfterLayout(true);
    } else {
      incrementPending(newCount);
      showFollowButton();
    }
  }

  // Reactive mode: once Svelte has rendered the new entries, flag them so the
  // caller can apply the new-entry highlight.
  if (newIds.length && typeof onNewEntries === 'function') {
    onNewEntries(newIds);
  }

  return { entries, newCount };
}

export function wireSessionEvents({
  eventSource,
  onReload,
  onChatPreview,
  onError = () => {},
  windowImpl = typeof window !== 'undefined' ? window : null,
  CustomEventImpl = typeof CustomEvent !== 'undefined' ? CustomEvent : null,
} = {}) {
  const dispatch = (type, detail) => {
    if (!windowImpl || !CustomEventImpl) return;
    try {
      windowImpl.dispatchEvent(new CustomEventImpl(type, { detail }));
    } catch (_) {}
  };
  const dispatchReloadedEvent = () => {
    dispatch('pi-session-reload');
  };

  eventSource.onmessage = (event) => {
    if (event.data !== 'reload') return;
    // `onReload` returns a Promise once handleSessionReload starts; await it so
    // the broadcast fires *after* the model has the new entries. Otherwise
    // listeners that read the model on this event (e.g. steer-queue reconciling
    // its chips against newly-arrived user messages) race the fetch and see a
    // stale snapshot.
    const result = onReload(event);
    if (result && typeof result.then === 'function') {
      result.then(dispatchReloadedEvent, dispatchReloadedEvent);
    } else {
      dispatchReloadedEvent();
    }
  };
  eventSource.addEventListener('chat-preview', (event) => {
    try {
      const payload = JSON.parse(event.data);
      onChatPreview(payload);
      // The file-watch 'reload' event is dropped for a brand-new session's first
      // write (the watcher treats it as an initial observation, not a change), so
      // the canonical entries would never reconcile until a manual refresh. The
      // chat-preview stream is worker-driven and independent of the watcher, so
      // its 'done' signal is a reliable trigger to pull the written entries.
      if (payload && payload.done) {
        const result = onReload(event);
        if (result && typeof result.then === 'function') {
          result.then(dispatchReloadedEvent, dispatchReloadedEvent);
        } else {
          dispatchReloadedEvent();
        }
      }
    } catch (error) {
      onError(error);
    }
  });
  // 'queue' is fired by the backend whenever the per-session chat_queue
  // changes — autonomous drainer, another tab, etc. ChatComposer listens for
  // pi-queue-event on the window and refetches /api/chat/queue.
  eventSource.addEventListener('queue', () => {
    dispatch('pi-queue-event');
  });
  for (const [eventName, windowEvent] of [
    ['extension-ui-request', 'pi-extension-ui-request'],
    ['extension-ui-resolved', 'pi-extension-ui-resolved'],
    ['extension-notify', 'pi-extension-notify'],
  ]) {
    eventSource.addEventListener(eventName, (event) => {
      try {
        dispatch(windowEvent, JSON.parse(event.data));
      } catch (error) {
        onError(error);
      }
    });
  }
  eventSource.onerror = onError;
  return eventSource;
}
