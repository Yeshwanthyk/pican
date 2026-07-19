# pican: redesign + TypeScript + Effect v4 migration plan

Branch: `redesign-effect-ts` (branched off `codex-app-server`; the working tree carries intentional uncommitted changes from that branch — do not revert or clean them).

This plan is self-contained: an implementing agent needs only this file, the repo, and the reference checkouts listed below. Work proceeds in waves; each wave has a hard gate. Do not start a wave until the previous wave's gate passes. Commit at each wave boundary with a message naming the wave.

## 0. Context

pican is a Go server (`internal/`) + Svelte 5 SPA (`web/`) for driving `pi`/Codex coding-agent sessions. The frontend is currently plain JS (no TS), eslint + prettier, vitest, built by Vite and embedded into the Go binary. Two renders exist: the live SPA and a static export (`web/src/export`, `vite.config.export.js`) — **never leak live-only SPA/chat/SSE behavior into the export render** (project contract, see `AGENTS.md`).

Verification commands (repo root):
- `make test` — vitest + `go test ./...`
- `make check` — lint + format-check + test + build + vet (final gate for every wave from Wave 2 on)
- `make build` — always use this, never bare `go build` (embeds frontend assets)
- `make e2e` — Playwright (Wave 5 only; needs `make e2e-setup` once)

### Goals
1. Replace eslint/prettier with **oxlint + oxfmt**, using the executor repo's lint ruleset (custom oxlint JS plugin enforcing Effect discipline).
2. Migrate `web/src` to **strict TypeScript**.
3. Introduce **Effect v4** (`effect@4.0.0-beta.98`) so all async/failable operations are typed Effects with a **tagged-error taxonomy capturing every error state** (network, HTTP status, decode, abort, storage, SSE, worker-crash).
4. Implement the locked **design verdicts** (§ Wave 4 spec below) for the home and session pages, mobile-first.
5. `make check` green, docs updated.

### Reference material (read-only)
| What | Path |
| --- | --- |
| Effect v4 source of truth | `~/.opensrc/repos/github.com/Effect-TS/effect-smol/4.0.0-beta.98/packages/effect/src/` |
| Effect v4 pattern guides | `~/.opensrc/repos/github.com/Effect-TS/effect-smol/4.0.0-beta.98/ai-docs/src/` (`01_effect`, `03_stream`, `50_http-client`, `09_testing`, …) + repo-root `AGENTS.md`, `LLMS.md` |
| Executor oxlint config | `~/.opensrc/repos/github.com/RhysSullivan/executor/main/.oxlintrc.jsonc` |
| Executor oxlint plugin (rules to copy) | `~/.opensrc/repos/github.com/RhysSullivan/executor/main/scripts/oxlint-plugin-executor.js` + `scripts/oxlint-plugin-executor/` |
| Executor oxfmt config | `~/.opensrc/repos/github.com/RhysSullivan/executor/main/.oxfmtrc.json` |
| Design reference mock (all verdicts, interactive) | https://claude.ai/code/artifact/c068cce4-5e69-41d0-bc0e-bd3ecd22dacb |

**Standing rule: whenever writing or reviewing Effect code, consult the effect-smol checkout first** — v4 differs from v3 and from most training data. If an API is uncertain, read the source module in `packages/effect/src/` before using it. Refresh/fetch references with the `opensrc` CLI (`opensrc path <pkg>`).

### Delegation model
Implementation is delegated to Codex; the orchestrating agent reviews and iterates:

```sh
command codex exec --skip-git-repo-check -m gpt-5.6-sol -c model_reasoning_effort=medium --sandbox workspace-write -C /Users/yesh/code/personal/pican "<prompt>" </dev/null
```

Rules learned the hard way:
- Run codex **in the foreground** (blocking call, generous timeout ~10 min). Detached/background codex invocations wedge silently.
- One small scoped run per step; verify file state between runs. A codex run that produces zero file changes is a failure — retry once, then do the step by hand.
- Codex prompts must be plain, complete, self-contained: task, files, definition of done. No motivational framing.
- Parallel codex runs must own **disjoint directories** (see Wave 3 partition map).

### Frontend inventory (for partitioning)
| Directory | js modules | tests | svelte |
| --- | --- | --- | --- |
| `web/src/shared` | 16 | 13 | 0 |
| `web/src/index` | 4 | 3 | 0 |
| `web/src/session` (subdirs: artifacts, chat, data, live, navigation, page, render, tree, ui) | 42 | 33 | 0 |
| `web/src/routes` | 2 | 3 | 8 |
| `web/src/components` (index, session, settings, shared, tasks, workflows) | 32 | 61 | 59 |
| `web/src/settings`, `tasks`, `workflows`, `subagents`, `export` | 1 each | ~1 each | 0 |

CSS is NOT in `web/` — it lives as Go-embedded files in `internal/ui/embedded/styles/*.css` (`theme.css`, `index.css`, `session.css`, …), concatenated into one bundle (`internal/ui/app_styles.go`). Design-wave CSS changes go there. Design tokens/spec: `docs/design/design-system.md`.

---

## Wave 1a — Tooling: oxlint, oxfmt, TypeScript, deps

**STATUS: DONE (verified 2026-07-18, uncommitted).** Actual installed versions: `effect@4.0.0-beta.98` + `@effect/platform-browser@4.0.0-beta.98` (exists, exact-pinned), `oxlint@1.74.0`, `oxfmt@0.59.0`, `typescript@5.9.3`, `svelte-check@4.7.3`, `@effect/language-service@0.87.0`. Deviations from the spec below: `skipLibCheck: true` added to tsconfig (third-party `.d.ts` noise from `@pierre/diffs`/shiki); `.svelte` files included in the JS-override glob (they are pre-migration code too — remove them from the override as Wave 3 partitions land); ~220 files reformatted by oxfmt (quote style only). All four gate commands observed green. The section below is kept as the spec of record.

**Scope: `web/` config + root `Makefile`. No source migration yet.**

1. **Plugin**: copy executor's plugin to `web/scripts/oxlint-plugin-pican.js` + `web/scripts/oxlint-plugin-pican/` (rules/ + utils.js). Rename plugin `meta.name` to `pican`. Delete these 5 rules (executor-monorepo/React-specific) and their imports/registry entries: `no-cross-package-relative-imports`, `no-direct-cloud-executor-schema-import`, `no-raw-durable-object-id`, `require-reactivity-keys`, `no-vitest-import`. Keep all other rules byte-identical.
2. **`web/.oxlintrc.jsonc`** modeled on executor's, adapted:
   - no `react` plugin / `react/forbid-elements`
   - `jsPlugins: [{ "name": "pican", "specifier": "./scripts/oxlint-plugin-pican.js" }]`
   - rules: `typescript/no-explicit-any: error` + every remaining `pican/*` rule at `error`
   - override for `["src/**/*.js", "*.js", "*.config.js"]`: disable the effect-discipline `pican/*` rules (`no-try-catch-or-throw`, `no-error-constructor`, `no-json-parse`, `no-switch-statement`, `no-promise-catch`, `no-promise-reject`, `no-instanceof-error`, `no-instanceof-tagged-error`, `no-manual-tag-check`, `no-unknown-error-message`, `no-effect-escape-hatch`, `no-match-orelse`, `no-raw-fetch`, `prefer-yield-tagged-error`, `prefer-effect-predicate`, `no-conditional-tests`). Rationale: JS files are pre-migration; every file converted to TS becomes fully strict. **As directories migrate in Wave 3, this override shrinks and is deleted at the end of Wave 3.**
   - `ignorePatterns`: `dist/`, `dist-export/`, `node_modules/`, `coverage/`
3. **`web/.oxfmtrc.json`**: like executor's; ignore `dist`, `dist-export`, `node_modules`, `package-lock.json`.
4. **`web/tsconfig.json`**: `strict`, `target ES2022`, `module ESNext`, `moduleResolution bundler`, `allowJs true`, `checkJs false`, `noEmit`, `isolatedModules`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `forceConsistentCasingInFileNames`, `types ["vite/client", "svelte"]`, `plugins [{ "name": "@effect/language-service" }]`, include `src/**/*.{ts,js,svelte}`.
5. **`web/package.json`**:
   - remove: `eslint`, `@eslint/js`, `eslint-plugin-svelte`, `globals`
   - keep: `prettier` + `prettier-plugin-svelte` (scoped to `.svelte` only — oxfmt cannot format Svelte)
   - add devDeps: `oxlint ^1.56`, `oxfmt` (latest), `typescript ^5.9`, `svelte-check` (svelte-5 compatible), `@effect/language-service`, `@types/node`
   - add dep: `effect@4.0.0-beta.98` (exact). If `@effect/platform-browser@4.0.0-beta.98` exists on npm, add it (exact) — check with `npm view`.
   - scripts: `lint: oxlint`; `format: oxfmt && prettier --write "src/**/*.svelte"`; `format:check`: oxfmt's check mode (verify flag via `--help`) + `prettier --check "src/**/*.svelte"`; `typecheck: tsc --noEmit && svelte-check --threshold error` (if svelte-check fails on legacy code, run `tsc --noEmit` only and add svelte-check in Wave 3); keep `test`/`build`/`dev`/`knip`.
   - delete `web/eslint.config.js`; fix `web/knip.config.js` references.
6. **Makefile**: keep web target *names* stable; they now run the new tools. Add `typecheck` into the web check path. Do not touch Go targets.

**Gate 1a**: `(cd web && npm install && npm run lint && npm run format:check && npm run typecheck)` and `make build` all exit 0. Commit: `Wave 1a: swap to oxlint/oxfmt, add TS + effect deps`.

---

## Wave 1b — Effect foundation (`web/src/lib/`)

New strict-TS modules only; nothing else imports them yet. Consult `ai-docs/src/01_effect` (core patterns), `50_http-client`, `03_stream`, `09_testing` and the `packages/effect/src` source. **v4 notes**: `Schema` is in `effect` core; `Effect.Service`/`Layer` APIs follow v4 (effect-smol) signatures, not v3.

1. **`web/src/lib/errors.ts`** — the complete tagged-error taxonomy (all `Schema.TaggedError` or v4 `Data.TaggedError` equivalents — match what effect-smol prescribes):
   - `NetworkError { cause }` — fetch rejected (offline, DNS, CORS)
   - `HttpError { status, url, body }` — non-2xx; constructors/refinements for 401/404/5xx
   - `DecodeError { url, issue }` — response failed Schema decode
   - `AbortError {}` — caller-cancelled
   - `TimeoutError { url, millis }`
   - `StorageError { key, op, cause }` — localStorage read/write/parse
   - `SseError { phase: "connect" | "stream" | "parse", cause }`
   - `WorkerDownError { code }` — session worker crash surfaced by API/SSE
   Export `ApiError = NetworkError | HttpError | DecodeError | AbortError | TimeoutError` and a `describeError(e): string` used by UI (Plain-state copy, § Wave 4).
2. **`web/src/lib/schema.ts`** — Schema models for every API payload the frontend consumes. Derive the shape list from current `web/src/shared/api.js` call sites and `web/src/index/sessions.js` `normalizeSession`: Session, SessionList, Project, ScheduleList, QueueState/QueueItem, DirBrowse, VersionInfo, TaskList, WorkflowRun, SubagentList, PeerList, plus request bodies. Types are inferred from schemas (`Schema.Type<...>`) — no hand-written duplicate interfaces (`prefer-schema-inferred-types` lint rule enforces).
3. **`web/src/lib/http.ts`** — `apiFetch` built on `@effect/platform-browser` FetchHttpClient if the beta.98 package exists, else a thin `Effect.tryPromise`-free wrapper per v4 idiom (`Effect.callback`/`Effect.tryPromise` as ai-docs prescribes) mapping every failure mode to the taxonomy: fetch rejection→`NetworkError`, !ok→`HttpError` (reading body text), decode→`DecodeError`, AbortSignal→`AbortError`. Signature: `get(url, schema)`, `post(url, body, schema)`, `del`, … each returning `Effect<A, ApiError>`. JSON parsing only via Schema (lint bans `JSON.parse`).
4. **`web/src/lib/storage.ts`** — localStorage service: `getJson(key, schema)`, `setJson`, failures → `StorageError`; degrade-to-default helpers.
5. **`web/src/lib/sse.ts`** — EventSource wrapper as `Stream` (v4 `Stream` from effect-smol): typed events, reconnection with `Schedule` backoff, failures → `SseError`. Mirror semantics of current `web/src/shared/status-events.js`.
6. **`web/src/lib/runtime.ts`** — one app runtime (v4 ManagedRuntime equivalent) + Svelte bridges: `runPromise(effect, { signal })`, `runFork`, and `effectResource(effect)` returning `{ state: "loading" | "ok" | "error", value?, error? }` as a Svelte-5-runes-friendly store for components. All UI consumption of Effects flows through this module; components never call `Effect.run*` directly.
7. **Tests** — vitest unit tests per module (error mapping table for http; storage fallbacks; sse parse). Keep plain vitest (the `no-vitest-import` executor rule was dropped); use `Effect.runPromise` via the runtime in tests.

**Gate 1b**: `npm run lint` (new files fully strict, zero pican-rule violations), `npm run typecheck`, `npm test` green. Commit: `Wave 1b: Effect foundation — errors, schemas, http, storage, sse, runtime`.

---

## Wave 2 — API layer cutover

Convert `web/src/shared/api.js` (+ its test) to `api.ts` re-exported on top of `lib/http.ts`, preserving the existing exported function names/signatures as thin adapters: each old `async` function becomes `runPromise(apiGet(...))` so **existing JS callers keep working unchanged** while migrated TS callers import the Effect-returning variants directly (`api.effects.*`). Also convert `shared/status-events.js` → `status-events.ts` on `lib/sse.ts`, and `shared/storage.js`/`settings-store.js` → TS on `lib/storage.ts`, with the same adapter discipline.

**Gate 2**: full `make check` green (all other files still JS and untouched). Commit.

---

## Wave 3 — JS→TS migration on Effect (parallel partitions)

Each partition = one codex-driven subagent owning a **disjoint** file set. Within a partition: rename `.js` → `.ts` (tests too, `.test.ts`), add precise types (no `any`, no `as X` double-casts, no non-null `!` — lint enforces), replace raw `fetch`/`try-catch`/`JSON.parse`/promise chains with `lib/` Effect APIs, and switch Svelte `<script>` to `lang="ts"` for components in the partition. Update imports in-place; Vite resolves `.ts` automatically — **do not leave duplicate `.js` files**.

Partition order (A–B first, then C–F in parallel, G last):
- **A. `shared/` remainder** (13 modules: navigation, strings, theme, toast, icons, keyboard-nav, escape, clipboard, fonts, version, english, command-palette-runtime) — everything imports these; land first.
- **B. `index/`** (sessions, peers, schedules, dir-browse) + `routes/SessionsPage.svelte` + `components/index/*` (Svelte → lang=ts).
- **C. `session/data` + `session/render` + `session/live`** — transcript model, entry rendering, follow/live reconciliation.
- **D. `session/chat` + `session/page` + `session/ui` + `session/navigation` + `session/artifacts` + `session/tree` + remaining session root modules.
- **E. `components/session/*`** (largest Svelte set: SessionShell, SessionEntry, ToolCall, ChatComposer, QueuePanel, modals…).
- **F. `settings/`, `tasks/`, `workflows/`, `subagents/`, `components/{settings,shared,tasks,workflows}`, `routes/` remainder, `App.svelte`, `main.js→ts`.
- **G. `export/`** — migrate types only; **do not** introduce runtime/SSE imports (export must stay static; contract).

Per-partition DoD: `npm run lint` + `npm run typecheck` + `npm test` green with the partition fully strict (its files removed from the JS-override in `.oxlintrc.jsonc`). After G: delete the JS override block entirely, delete any leftover `allowJs` need (`allowJs: false`), run full `make check`. Commit per partition.

---

## Wave 4 — Design implementation (locked grilling verdicts)

Interactive reference: the design-lab artifact (§ references). Tokens stay the existing Obsidian theme (`--body-bg:#111116`, accent `#9cc7c0`, danger `#ef767a`; amber for "needs you" — add token `--attention: #d8b45a` to `theme.css` for all 14 themes with per-theme values where sensible). **Colored left-edge status stripes are banned.** CSS edits go to `internal/ui/embedded/styles/{theme,index,session}.css`; markup/logic to `web/src`. User-facing strings via `t()` / `web/src/shared/english.(ts)`.

### 4.1 Home (`SessionsPage.svelte`, `components/index/*`, `index.css`)
- **Ticker rows** replace current cards: flat full-width rows, hairline separators; row = title line (13.5px; live → `#fff` weight 600), optional status sub-line, foot line (`project · model` left, `tok · cost · when` right, `tabular-nums`).
  - Live sub-line (accent): `● {current activity} · {elapsed}` — pulsing 6px dot (1.6s ease-in-out, 35% opacity trough, only while live, `prefers-reduced-motion` disables).
  - Waiting sub-line (attention): `● waiting {duration} — {question preview}` (sessions blocked on `ask_user_question`).
  - Pinned `⌖` / btw `~` inline markers before title, accent-colored.
- **Grouping**: if any session is live or waiting → new "Now" group first (live then waiting), then Pinned, then existing date buckets (`groupSessionsByDate`); members of Now are excluded from lower groups. Idle → Pinned + date buckets (current behavior).
- **Header sub-line**: `{n} sessions · {r} running · {w} needs you` (colored) or `{n} sessions · all idle`.
- **Mobile chrome (<900px, reuse `MOBILE_BREAKPOINT_PX`/`isMobileLayout`)**: replace FAB + header icon cluster with bottom **thumb bar**: search field (opens ⌘K palette), accent `+` (46px, opens NewSessionModal), `⋯` (HomeMenu). Header shrinks to one line: `π sessions · counts`.
- **Desktop chrome (≥900px)**: top bar (mark/title/counts left; search field with ⌘K hint, labeled `+ new session`, schedules, menu right). Two-column body: list (max ~760px) + right rail — live: "Waiting on you" card (question text + inline answer buttons that send the reply to that session via chat API); idle: Schedules summary; Machines/peers section below (absorbs `MachinesSection`).

### 4.2 Session transcript (`components/session/SessionEntry.svelte`, `ToolCall.svelte`, `session.css`)
- **Prose**: user message = tiny uppercase who-label `YOU · {time}` (accent) + bold near-white prose, no left border; assistant = who-label `{model}` (muted) + 13.5px prose, line-height 1.65; streaming answer's label gains `· live` + blinking accent caret.
- **Activity fold**: per turn, one collapsible `<details>`-style fold between user message and answer replacing today's inline tool run groups: summary `{n}s thinking · {k} tool run(s)` + ` · edits` when any tool has a diff; expanded body = thinking line + one row per tool (`{tool} {cmd} … {result}` right-aligned) behind a 1px left hairline. Auto-open only for the live turn; live summary leads with attention-colored `● running {cmd} · {elapsed}`. Existing Thinking/Tools/Tool-output visibility toggles map onto fold defaults.
- **Diffs — Words renderer + Sheet policy** (in `ToolCall.svelte` edit rendering):
  - Renderer: header (short filename + `+a −d`), unified rows with line numbers, add/del row tints ~7% opacity, **word-level highlight** spans (~28% opacity) on intra-line changes (compute via simple common-prefix/suffix split of del/add line pairs).
  - Policy: ≤8 changed lines → expanded inline; larger → collapsed chip `± {file} +a −d ▸`; expanded large diff renders edge-to-edge on mobile (escape transcript padding with negative margins), rounded card on desktop; footer actions `open full diff` (existing DiffModal) + `copy patch`.
- **Composer: unchanged.** Do not restyle ChatComposer/ChatToolbar/QueuePanel.

### 4.3 States — "Plain" voice (strings in `english`, styles in both pages' css)
One muted line + one dim sub-line, centered; fix stated inline; no cards/glyphs/apologies:
- First run: `no sessions yet` / `press + to start one in {default project}`
- No search results: `no matches for "{query}"` / `esc clears the search`
- Worker crashed: inline in transcript at death point — danger `worker exited ({code}) — stream ended here` + `restart from the ⋯ menu · transcript is saved`; composer disabled (`restart the worker to continue…`); header sub gains danger `worker down`; streaming caret turns danger and stops blinking. Wire from `WorkerDownError`/SSE close states.
- View-only: composer area → `view only · resume in terminal: {command}` (tap to copy); header sub gains attention `view only`.

### 4.4 Micro (apply throughout)
`tabular-nums` on all metrics/counts/times; touch targets ≥44px mobile / ≥40px desktop; press feedback `scale(0.96)`; transitions 0.12s ease on named properties only (never `transition: all`); concentric radii (outer = inner + padding).

**Gate 4**: `make check` green; e2e specs that assert old home-card/FAB/tool-row DOM updated accordingly; screenshots on mobile viewport compared against the reference artifact. Commit per sub-section (4.1/4.2/4.3).

---

## Wave 5 — Final gate + docs

1. Full `make check` and `make e2e` green (fix or update specs; `e2e/tests/mobile-layout.spec.ts`, `steer-queue.spec.ts`, `settings.spec.ts` are most likely to need updates).
2. Docs (project contract requires): update `docs/architecture/frontend.md` (TS + Effect layer, lib/ modules, error taxonomy, runtime bridge), `docs/design/design-system.md` (Ticker rows, thumb bar, activity fold, Words diff, Plain states, `--attention` token), `docs/README.md` index if needed; note oxlint/oxfmt + typecheck in `CONTRIBUTING.md` and `docs/dev/` where eslint/prettier are mentioned.
3. Update `README.md` only where it documents dev commands.
4. Final commit; leave push/PR to the user.

## Risks & gotchas
- **Effect v4 beta**: APIs differ from v3 and from model priors. Always confirm against effect-smol source. If `@effect/platform-browser` beta is absent, hand-roll the fetch wrapper in `lib/http.ts` (small surface).
- **oxlint does not lint `.svelte`**: keep component `<script>` logic thin; push logic into `.ts` modules where lint applies. `svelte-check` covers types in components.
- **Vitest + jsdom** tests currently import `.js` paths; renames must update imports (codex prompts should say "update all importers in the same run").
- **Export render isolation**: Wave 3G and Wave 4 must not add SSE/runtime imports to `web/src/export` or export Vite config.
- **Embedded CSS**: `make build` re-embeds; after CSS edits always verify via `make build`, not vite alone.
- **Worker lifecycle contract**: session files are append-only for `session_info`; one worker per session, evict crashed, reap idle at 10 min — the crashed-state UI (4.3) reads these states, never changes the lifecycle.
