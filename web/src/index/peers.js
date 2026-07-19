import { getJSON, postJSON } from "../shared/api.js";
import { normalizeSession } from "./sessions.js";

export function defaultFetchPeers() {
  return getJSON("/api/peers");
}
export function defaultUpsertPeer(name, baseUrl, token) {
  return postJSON("/api/peers", { name, baseUrl, token });
}
export function defaultRemovePeer(name) {
  return postJSON("/api/peers", { name, action: "remove" });
}
export function defaultFetchPeerSessions() {
  return getJSON("/api/peers/sessions");
}

// normalizePeerSession extends normalizeSession with the host/hostUrl fields
// the server stamps onto every remote summary, so a peer session can build a
// deep link back to the machine it actually lives on.
export function normalizePeerSession(raw = {}) {
  return {
    ...normalizeSession(raw),
    host: raw.host || "",
    hostUrl: raw.hostUrl || "",
  };
}

// normalizePeerHost shapes one entry of GET /api/peers/sessions' "hosts"
// array for the homepage Machines section.
export function normalizePeerHost(raw = {}) {
  return {
    name: raw.name || "",
    baseUrl: raw.baseUrl || "",
    online: !!raw.online,
    error: raw.error || "",
    sessions: Array.isArray(raw.sessions) ? raw.sessions.map(normalizePeerSession) : [],
  };
}
