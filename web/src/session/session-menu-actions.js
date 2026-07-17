// Network actions behind the session command menu, split out of CommandMenu so
// the component keeps only UI orchestration (open/close, toast, navigate) and
// these stay unit-testable in isolation.

const sessionUrl = (path, id) => `${path}?id=${encodeURIComponent(id)}`;

export async function renameSession(sessionId, name, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl('/api/rename-session?id=' + encodeURIComponent(sessionId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'rename failed');
  return data;
}

// Fetches fresh entries — the in-memory model is stale after a live reload.
export async function loadForkEntries(sessionId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(sessionUrl('/api/session', sessionId));
  const data = await res.json();
  return data.entries || [];
}

export async function forkSession(sessionId, entryId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(sessionUrl('/api/fork-session', sessionId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId }),
  });
  return res.json();
}

export async function cloneSession(sessionId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(sessionUrl('/api/clone-session', sessionId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return res.json();
}
