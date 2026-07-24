# Architecture Documentation

This directory contains the architecture documentation for **pican**, a local web viewer and controller for Pi sessions, Codex threads, and Claude Code sessions.

## Documents

| Document | Description |
|----------|-------------|
| [system-overview.md](./system-overview.md) | High-level system architecture, component diagram, and tech stack |
| [backend.md](./backend.md) | Go backend: packages, responsibilities, and key types |
| [frontend.md](./frontend.md) | Frontend architecture: embedded templates, Vite build, and vanilla JS |
| [data-flow.md](./data-flow.md) | Session file formats, projections, data model, and storage layout |
| [codex-runtime.md](./codex-runtime.md) | Codex app-server integration, authority boundaries, projections, and lifecycle |
| [claude-runtime.md](./claude-runtime.md) | Claude native transcript catalog/projection plus installed-CLI stream-json worker lifecycle |

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Browser                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │
│  │  / (index)  │  │ /session?id │  │      SSE /events            │  │
│  │  Svelte SPA │  │  Svelte SPA │  │ projections + previews +    │  │
│  │   (Vite)    │  │   (Vite)    │  │        status               │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ HTTP
┌─────────────────────────────────────────────────────────────────────┐
│                        pican HTTP Server                            │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │   Auth     │ │  Handlers  │ │   SSE      │ │  File Watcher    │  │
│  │Middleware  │ │  (server)  │ │ (events)   │ │ (fsnotify/poll)  │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────────┘  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │  Sessions  │ │  Workers   │ │  Runtime   │ │  Share (gh)      │  │
│  │  (cache)   │ │  (manager) │ │ adapters   │ │  (gist create)   │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼ filesystem
┌─────────────────────────────────────────────────────────────────────┐
│                    ~/.pi/agent/sessions/                             │
│  Pi transcripts: timestamp_uuid.jsonl                                │
│  Codex projections: codex-<thread-id>.jsonl (authority: ~/.codex)    │
│  Claude projections: claude-<session-id>.jsonl (authority: ~/.claude)│
└─────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

1. **Runtime-specific authority**: Native Pi transcripts are append-only; Pi supplies conversation entries and pican appends supported metadata. Codex remains authoritative in `~/.codex`; Claude remains authoritative under its configured `<home>/projects`; pican atomically rebuilds replaceable projections while preserving local metadata.

2. **Live updates via SSE**: The browser opens an EventSource connection. The server watches session files via `fsnotify` (with polling fallback) and pushes `reload` events; session pages fetch `/api/session` to reconcile canonical JSONL entries. Browser chat can also receive best-effort `chat-preview` SSE events before JSONL reconciliation.

3. **Runtime workers**: Each active chat-capable session gets one reusable worker selected from its header: `pi --mode rpc`, `codex app-server --stdio`, or installed `claude` bidirectional stream-json. Crashed workers are evicted and idle workers are reaped after 10 minutes.

4. **Dual frontend strategy**:
   - **Index page** (`/`): Built with Vite + vanilla JS, served from embedded `web/dist`
   - **Session page** (`/session`): Server-rendered HTML shell with Vite-built session JS

5. **Security**: Token-based auth (`PICAN_TOKEN`) is required when binding to non-loopback addresses (e.g., Tailscale).
