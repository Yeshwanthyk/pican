# End-to-End Testing (Playwright)

The `e2e/` project drives a real browser against the **built** `pican` binary.
It complements the Vitest unit tests (`web/`) and Go tests (`internal/`) by
exercising whole flows — page rendering, SSE live-reload, settings persistence,
and chat — across desktop, mobile, and iPad viewports.

It is intentionally **not** part of `make test` / `make check`: it needs browser
binaries and a running server, so it runs as its own target and CI job.

## Quick start

```bash
make e2e-setup           # one-time: install deps + Playwright browsers
make e2e                 # build the binary, then run the whole suite
make e2e-perf            # one serial Pixel 5 performance correctness sample
make e2e-perf-record     # isolated repetitions: 20 local / 5 in CI by default

# or, from e2e/ directly (assumes ./pican is already built):
cd e2e
npx playwright test                                  # all projects
npx playwright test --project="Desktop Chrome"       # one project
npx playwright test tests/chat.spec.ts               # one spec
npx playwright test --ui                             # interactive debug UI
npx playwright show-report                           # open last HTML report
```

`make e2e` runs `make build` first because of `//go:embed web/dist` — the binary
embeds the frontend, so E2E always runs against freshly built assets.

## Watching tests run (headed mode)

Tests run headless by default. To watch a real browser and verify with your own
eyes before trusting the headless run:

```bash
cd e2e

# Open a visible browser. Pin to ONE project or every browser launches at once.
npx playwright test --headed --project="Desktop Chrome"

# One window at a time (don't stack 7 browsers), good for watching a full file.
npx playwright test --headed --project="Desktop Chrome" --workers=1

# Step through interactively: pick tests, watch, re-run, inspect the DOM.
npx playwright test --ui

# Pause on the first action and drive it manually (Playwright Inspector).
PWDEBUG=1 npx playwright test --project="Desktop Chrome" tests/chat.spec.ts
```

Tips for eyeballing:

- Always add `--project=...` in headed mode — otherwise all 7 browsers open together.
- `--workers=1` runs tests one at a time so windows don't stack up.
- `--ui` (the Playwright UI runner) is usually the nicest way to watch + re-run.
- To slow actions, set `use: { launchOptions: { slowMo: 500 } }` temporarily in
  `playwright.config.ts`, or use `PWDEBUG=1` to step manually.
- Headed vs. headless is just a flag — the same specs run both ways, so once it
  looks right headed, drop `--headed` to go back to fast/CI mode.

## Project matrix

Layout follows a **900px breakpoint**, not device type. Seven projects:

| Project                   | Engine   | Viewport     | Layout  |
| ------------------------- | -------- | ------------ | ------- |
| Desktop Chrome            | Chromium | 1280         | desktop |
| Desktop Firefox           | Firefox  | 1280         | desktop |
| Desktop Safari            | WebKit   | 1280         | desktop |
| Mobile Chrome (Pixel 5)   | Chromium | 393          | mobile  |
| Mobile Safari (iPhone 13) | WebKit   | 390          | mobile  |
| iPad (gen 7)              | WebKit   | 810 portrait | mobile  |
| iPad landscape            | WebKit   | ~1080        | desktop |

These are Playwright **device emulation** (real viewport/touch/UA/DPR, desktop
engine binary), not real devices. `webkit` is the Safari _engine_, not literal
Safari.app — good enough for layout/touch regressions and runs on Linux CI.

Tests that depend on layout resolve it at runtime with `isMobileLayout(page)`
(checks `matchMedia('(max-width: 900px)')` **after navigation** — about:blank
does not reflect the project viewport) and `test.skip()` the half that doesn't
apply. iPad portrait exercises mobile, iPad landscape exercises desktop.

### Expected skips

A full run includes intentional `test.skip()` guards for tests that only apply
to one side of the responsive breakpoint or that would race on shared
server-side state. Each skip carries a reason string, visible with
`npx playwright test --reporter=list`; the healthy invariant is **0 failed**,
not a fixed passed/skipped count as the matrix grows.

The screenshot capture spec is also excluded from normal runs because it writes
committed documentation images. Opt into it explicitly:

```bash
PICAN_E2E_SCREENSHOTS=1 npx playwright test --grep "@screenshots" \
  --project="Desktop Chrome" --workers=1
```

## How the server runs (scripted launch)

`global-setup.ts` (see `e2e/lib/server.ts`):

1. Ensures `./pican` exists (CI builds it first; locally `make build` if missing).
2. Creates a temp `PI_CODING_AGENT_DIR` and copies `e2e/fixtures/sessions/` into it.
3. Picks a free port and starts `pican -host 127.0.0.1` (the `-host` flag skips
   Tailscale auto-serve; auth is disabled).
4. Prepends `e2e/lib/stub-pi/` to `PATH` so chat spawns the stub, never real pi.
5. Writes `{ baseURL, sessionsDir, agentDir, pid }` to `e2e/.tmp/server.json`.

The base fixture in `e2e/lib/test.ts` reads that file to set each test's
`baseURL` and to expose `sessionsDir` to mutating specs. `global-teardown.ts`
kills the server and removes the temp dir.

## Fixtures (sanitized real sessions)

Read-only specs assert against committed fixtures in `e2e/fixtures/sessions/`,
derived from **real** pi sessions and scrubbed. Regenerate with:

```bash
cd e2e
node scripts/sanitize-session.mjs <path-to-real-session.jsonl> \
  --name demo.jsonl --cwd /home/user/demo-project
```

The script rewrites home paths/username, redacts secret-shaped strings and
emails, and neutralizes the cwd + encoded directory name, while preserving entry
structure so the viewer still renders faithfully. **Always eyeball the output
before committing** — automated redaction is a safety net, not a guarantee.

Mutating specs don't touch the committed fixtures: live-reload and chat each
create a uniquely-named session file (`e2e/lib/sessions.ts`) inside an
already-watched subdir, so the 7 parallel projects never collide.

## The stub `pi`

Chat uses a `pi --mode rpc` worker (`internal/rpc`). CI has no real pi and no API
keys, so `e2e/lib/stub-pi/pi` answers the line-delimited JSON protocol:

- `switch_session` → remembers the session file path.
- `get_state` / `set_model` / `set_thinking_level` / `abort` → acknowledge.
- `prompt` → acks, then appends a user turn + a deterministic
  `Stub reply: <prompt>` assistant turn to the session JSONL (like real pi owns
  the file) and emits `message_update` / `message_end` / `turn_end` / `agent_end`.

The browser surfaces the reply through the same fsnotify → SSE reload path as a
real session. To extend chat coverage, add command handling in the stub mirroring
the real protocol in `internal/rpc/client.go`.

Note: chat is disabled ("View only") when a session's `cwd` doesn't exist on
disk, so chat specs build sessions with a real temp `cwd` (`realWorkingDir()`).

## CI

The `e2e` job in `.github/workflows/ci.yml`: `npm ci` →
`playwright install --with-deps chromium firefox webkit` → `make build` →
`npx playwright test`. The HTML report + traces upload as artifacts on failure
(`trace: on-first-retry`, `retries: 1` in CI).

## Adding a test

1. Put the spec in `e2e/tests/*.spec.ts` and import `{ test, expect }` from
   `../lib/test` (not `@playwright/test` directly) so `baseURL`/`sessionsDir` are wired.
2. For layout-specific assertions, gate on `isMobileLayout(page)` after navigating.
3. On narrow viewports the scratchpad overlays the header/composer — call
   `collapseScratchpad(page)` before `goto` (see chat/mobile specs).
4. For anything that writes to a session, create a per-test file via
   `e2e/lib/sessions.ts`; never mutate the committed fixtures.

Keep this doc in sync when specs, fixtures, or the project matrix change.

## Performance harness

The performance suite is separate from the normal E2E matrix. It is serial, uses one Pixel 5
Chromium project, and runs against the built binary with production large-transcript thresholds.
This reduces functional-test contention and cross-engine timing variance; it does not make the
emulated device a real phone.

### Commands

```bash
make e2e-perf-correctness # build, type-check, and run each app scenario once
make e2e-perf-record      # build, type-check, then record isolated repetitions

# Override the default 20 local samples (CI defaults to 5).
make e2e-perf-record PERF_REPETITIONS=3
PICAN_PERF_REPETITIONS=3 make e2e-perf-record

# Compare files or directories containing only V2 results.
make e2e-perf-compare \
  PERF_BASELINE=e2e/perf-results/accepted-run \
  PERF_CANDIDATE=e2e/perf-results/candidate-run

# Only after the baseline has been deliberately accepted:
make e2e-perf-compare \
  PERF_BASELINE=e2e/perf-results/accepted-run \
  PERF_CANDIDATE=e2e/perf-results/candidate-run \
  PERF_COMPARE_FLAGS="--baseline-accepted --max-median-regression 0.10"
```

`make e2e-perf` remains an alias for `e2e-perf-correctness`. The correctness target runs the
existing bounded-home, long-transcript/Load Earlier, and one offline-to-online exact-once catch-up
check. That last check is not a general recovery, crash, replay, or data-loss scenario suite; no
such coverage is claimed here.

The record target starts a fresh Playwright process, global setup, server, and temporary session
directory for every repetition. This prevents tracked projects, pins, generated sessions, and
other server state from leaking into the next sample. Do **not** replace that loop with
Playwright's `--repeat-each`: global setup is process-scoped, and the current app scenarios are not
fully isolated from their shared server fixture within one process. The record target labels these
fresh-process samples `cold`. `PICAN_PERF_TEMPERATURE=warm` can label a separately controlled warm
experiment, but this increment does not provide a trustworthy automated warm-cache protocol.

For contract-only checks that do not start pican or use app scenario behavior:

```bash
cd e2e
PICAN_PERF_HARNESS_ONLY=1 npx playwright test \
  --config=playwright.perf.config.ts perf/harness.spec.ts
```

### Result contract and artifacts

Every sample is checked at runtime before it is written as
`pican-performance-result` schema version 2. Invalid versions, missing identity fields,
non-finite measurements, invalid profile parameters, and malformed capabilities are rejected.
Schema V1 files are intentionally not accepted by the comparator.

Each result records:

- git SHA and dirty state;
- run ID, unique sample ID, one-based repetition, and explicit `cold`/`warm` label;
- OS platform/release/architecture, Node and Playwright versions, browser name and browser version
  when supplied/available (`PICAN_PERF_BROWSER_VERSION` may supply it);
- viewport, device-pixel ratio, headless state, and the full versioned profile parameters;
- explicit supported, unsupported, unavailable, or not-requested capability states;
- scenario fixtures and task timings, browser snapshots, long tasks, layout shift, DOM size, and
  memory counters where the engine exposes them; and
- per-resource pathname **plus query**, initiator type, transfer bytes, decoded bytes, start time,
  and duration. `snapshotDelta()` can attribute newly observed resources, long tasks, DOM entries,
  and heap change to two explicit task boundaries.

The persistent filename contains the SHA, profile, scenario, run ID, and unique sample ID, and is
created without overwrite permission. Repetitions therefore cannot silently replace an earlier
JSON file. The same checked payload is attached to its Playwright result. Persistent output
defaults to `e2e/perf-results/`; set `PICAN_PERF_OUTPUT_DIR` to separate baseline and candidate
runs.

The profile contract is versioned independently. `PICAN_PERF_PROFILE=mobile4g` currently means
profile V1: 150 ms latency, 500,000 B/s down (approximately 4 Mbps), 250,000 B/s up, and 4x CPU
slowdown. It is a Chromium CDP lab approximation. The metric/profile helpers do not attempt CDP on
WebKit; results explicitly report CDP/network/CPU throttling as unsupported there. The current
Playwright perf project remains Chromium-only.

### Statistics and timing gates

The comparator groups numeric `measurements.task` timing values whose names end in `Ms` by
scenario and reports sample count, median, nearest-rank p95, and max. Counts remain correctness
observations rather than being misclassified as timing regressions. Before computing timing differences it requires the baseline
and candidate to have identical project, temperature, OS/architecture/release, Node, Playwright,
browser/version, viewport/DPR, headless state, profile/version/parameters, and capability identity.
It refuses mixed or mismatched environments rather than producing a misleading comparison.

Timing gates are **provisional by default**: regressions are reported, but the comparator exits
successfully. Only the explicit `--baseline-accepted` flag (or
`PICAN_PERF_BASELINE_ACCEPTED=1`) makes the median regression threshold gating. Baseline acceptance
is a human release/process decision; recording a file does not accept it automatically. Pin runner
conditions and review repeated samples before accepting a baseline, and keep real-device checks for
release candidates.
