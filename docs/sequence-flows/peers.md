# Sequence Flow: Multi-Machine Peers (Registry + Aggregation)

This flow covers registering other pi-web instances ("peers") reached over Tailscale, and aggregating their sessions into a read-only "Machines" section on the homepage. This is phase 1: registry + aggregated view + deep-link navigation. There is **no proxying** — chatting with a remote session still happens on the peer's own origin.

## Sequence Diagram

```
┌─────────┐   ┌──────────────┐   ┌──────────┐   ┌─────────────┐
│ Browser │   │ Server (this │   │  SQLite  │   │  Peer pi-web │
│         │   │  pi-web)     │   │          │   │  (Tailscale) │
└────┬────┘   └──────┬───────┘   └────┬─────┘   └──────┬───────┘
     │               │                │                │
     │ POST /api/peers {name, baseUrl, token}
     │──────────────▶│                │                │
     │               │─── upsert peer_hosts row ──────▶│
     │               │                │                │
     │◀────────────── {ok:true} ──────│                │
     │               │                │                │
     │ GET /api/peers/sessions
     │──────────────▶│                │                │
     │               │─── SELECT * FROM peer_hosts ───▶│
     │               │◀── [{name, baseUrl, token}, …] ─│
     │               │                │                │
     │               │  fan out concurrently, 3s/peer timeout
     │               │──────────────────────────────────▶│ GET /api/sessions?limit=50
     │               │                                    │ X-Pi-Token: <token>
     │               │◀──────────────────────────────────│ {sessions:[...]}
     │               │                │                │
     │               │  tag each session with host/hostUrl
     │               │  (unreachable/401/timeout → online:false, error set;
     │               │   never blocks the other peers)
     │               │                │                │
     │◀────────────── {hosts:[{name,baseUrl,online,error,sessions}]}
     │               │                │                │
     │ click a peer's session card (opens in new tab)
     │───────────────────────────────────────────────────▶│ GET /session?id=<id>
     │                                                     │ (peer's own auth prompt
     │                                                     │  if no token cookie yet)
```

## Step-by-Step

### 1. Registering a peer

`Settings → Machines` posts to `POST /api/peers` with `{name, baseUrl, token}` (`web/src/components/settings/MachinesSettings.svelte` → `web/src/index/peers.js`). The server (`internal/server/peers.go` `handleUpdatePeer`) normalizes `baseUrl` (trims trailing slash, requires an absolute `http://`/`https://` URL) and upserts a row into `peer_hosts`. An update with an empty `token` field keeps whatever token is already stored — this lets the base URL be edited without re-entering the token. `{"action":"remove","name":...}` deletes the row.

`GET /api/peers` returns `{"peers":[{"name","baseUrl","hasToken"}]}` — **the token value itself is never returned**, only whether one is set.

### 2. Aggregating sessions

`GET /api/peers/sessions` (`handlePeersSessions`) loads every registered peer from SQLite and fans out concurrently (one goroutine per peer, `sync.WaitGroup`) to `GET <baseUrl>/api/sessions?limit=50` on each. Each peer request:

- Sends `X-Pi-Token: <token>` only when a token is configured for that peer (matches how `internal/auth/auth.go` extracts tokens on the receiving end).
- Is bounded by `peerFetchTimeout` (3s) via `context.WithTimeout`, using a single shared `*http.Client`/`http.Transport` so connections are reused across polls.
- Decodes the peer's JSON response into `map[string]any` per session (not a typed struct) so whatever field casing the peer emits survives untouched, then adds `host` and `hostUrl` keys to each session map before returning it.

A peer that times out, refuses the connection, or returns non-200 is reported as `online:false` with a short `error` string (`"unreachable"`, `"unauthorized"` for HTTP 401, or `"http <code>"`) — one slow or dead peer never blocks or fails the response for the others.

### 3. Rendering

The homepage (`web/src/routes/SessionsPage.svelte`) only calls `defaultFetchPeers()` once on mount; if zero peers are registered it never calls `/api/peers/sessions` again — zero overhead for single-machine users. Once at least one peer exists, `refreshPeerHosts()` polls `/api/peers/sessions` on the same debounced SSE-driven reload cadence as local sessions (`scheduleReload`, 500ms debounce).

`web/src/components/index/MachinesSection.svelte` renders one row per host (name, online dot, session count or error) below "Pinned" and above the date/project groups, expandable to a `PeerSessionRow` grid.

### 4. Navigating to a remote session

`PeerSessionRow.svelte` renders each remote session as `<a href="<hostUrl>/session?id=<id>" target="_blank" rel="noopener">` — a plain deep link, not client-side routing. Pin and chat-availability affordances are omitted since neither applies to a session this server doesn't own.

**Auth note:** the peer's token is stored only in *this* server's SQLite and is used solely for the server-to-server `/api/sessions` fetch. It is never embedded in the deep-link URL. When the browser opens the peer directly, that peer's own `internal/auth` flow prompts for its token independently (first-visit prompt / stored cookie), exactly as if the user had navigated there directly.

## The host-namespacing caveat

Session ids are bare filenames (e.g. `2026-07-18T12-00-00.jsonl`) and are **not unique across machines** — two different peers can produce colliding ids. This is why aggregation only ever produces a deep link (`<hostUrl>/session?id=<id>`) rather than routing through this server's own `/session?id=` — there is no single namespace in which a bare id unambiguously identifies a session across hosts. Every remote session reference in the aggregated response carries its `hostUrl` alongside `id` for exactly this reason.

## Next step (not implemented here)

A follow-up phase could add a full reverse proxy at `/h/<host>/*` so a remote session can be chatted with in-place (SSE, RPC calls, everything) without leaving this server's origin. That requires proxying WebSocket/SSE upgrades and the chat RPC round-trip through this server, plus a namespaced routing scheme (`/h/<host>/session?id=...`) to resolve the id-collision problem above. Phase 1 (this document) deliberately stops at read-only aggregation + deep-link navigation to keep the auth and proxying surface area minimal.

## Key Files

- `internal/server/peers.go` — schema, registry CRUD, aggregation fan-out
- `internal/server/peers_test.go` — httptest-backed fan-out/auth/timeout tests
- `web/src/index/peers.js` — fetch helpers + session/host normalization
- `web/src/components/settings/MachinesSettings.svelte` — registry UI
- `web/src/components/index/MachinesSection.svelte` / `PeerSessionRow.svelte` — homepage aggregation UI
- `internal/auth/auth.go` — the `X-Pi-Token`/`Authorization: Bearer` extraction each peer already implements
- `internal/app/tailscale.go` — how each pi-web instance publishes itself over Tailscale in the first place
