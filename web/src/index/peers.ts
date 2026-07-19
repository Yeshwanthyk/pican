import { effects } from "../shared/api.js";
import { runPromise } from "../lib/runtime";
import type { PeerHostSchema, Session } from "../lib/schema";
import { normalizeSession } from "./sessions.js";
import type { NormalizedSession } from "./sessions.js";

export interface NormalizedPeerSession extends NormalizedSession {
  host: string;
  hostUrl: string;
}

export interface NormalizedPeerHost {
  readonly name: string;
  readonly baseUrl: string;
  readonly online: boolean;
  readonly error: string;
  readonly sessions: NormalizedPeerSession[];
}

export function defaultFetchPeers() {
  return runPromise(effects.peers.list);
}
export function defaultUpsertPeer(name: string, baseUrl: string, token: string) {
  return runPromise(effects.peers.upsert(name, baseUrl, token));
}
export function defaultRemovePeer(name: string) {
  return runPromise(effects.peers.remove(name));
}
export function defaultFetchPeerSessions() {
  return runPromise(effects.peers.sessions);
}

// normalizePeerSession extends normalizeSession with the host/hostUrl fields
// the server stamps onto every remote summary, so a peer session can build a
// deep link back to the machine it actually lives on.
export function normalizePeerSession(raw: Partial<Session> = {}): NormalizedPeerSession {
  return {
    ...normalizeSession(raw),
    host: raw.host || "",
    hostUrl: raw.hostUrl || "",
  };
}

// normalizePeerHost shapes one entry of GET /api/peers/sessions' "hosts"
// array for the homepage Machines section.
type PeerHost = typeof PeerHostSchema.Type;

export function normalizePeerHost(raw: PeerHost): NormalizedPeerHost {
  return {
    name: raw.name || "",
    baseUrl: raw.baseUrl || "",
    online: !!raw.online,
    error: raw.error || "",
    sessions: Array.isArray(raw.sessions) ? raw.sessions.map(normalizePeerSession) : [],
  };
}
