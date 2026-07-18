# Project Contract

Read the relevant document under `docs/` before structural changes and update it when the architecture changes.

## Verification

```bash
make test   # vitest + go test ./...
make check  # lint + format-check + test + build + vet (run before pushing)
make e2e    # Playwright E2E; needs `make e2e-setup` once. Not in test/check
```

Always use `make build`; `go build` alone can embed stale or missing frontend assets.

## Source Ownership

- Root `README.md` and `user-docs/en/` are the documentation sources. Regenerate translations with `python3 scripts/build_readmes.py` and `python3 scripts/build_userdocs.py`; never hand-edit translated files.
- User-facing strings use `t()` from `web/src/shared/i18n.js`. Edit only `web/src/shared/locales/en.js`; other locale files are machine-drafted. Session content is never translated.

## Architecture

- Live app and export are separate renders. Never leak live-only SPA, chat, or SSE behavior into static export/share output.
- Existing session files are append-only for `session_info`; conversation entries come from the `pi --mode rpc` worker.
- Reuse one worker per session; evict crashed workers and reap idle workers after 10 minutes.
