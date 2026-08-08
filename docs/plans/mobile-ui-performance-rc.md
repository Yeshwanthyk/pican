# Mobile UI and performance RC evidence

Date: 2026-08-08

Implementation baseline: `924f075d5e693085f04e69aaacddfde431f881a5`

Measured source: `523a766ecb94f9db8156fe1a2a656ca9f9a561c2`

## Decision status

**Candidate available with two release-proof gaps.** Correctness automation and the local Chromium
lab runs pass. Timing thresholds remain provisional because accepting a baseline is a deliberate
review decision. Full V4 acceptance is also blocked by the heavy 20,000-entry Load Earlier anchor
case. No real-device Android run or post-fix five-task phone study has been recorded.

The source tree was measured dirty only because the pre-existing root `package.json` and
`package-lock.json` version bump was preserved. Those files are not part of this implementation
range.

## Delivered slices

| Slice | Source | Result |
|---|---|---|
| Compact Pinned → Now → Projects home | `adfd9d9`, `880296d` | Compact flat activity rows, bounded home contract, empty groups remain visible, mobile and desktop adaptation |
| Switching | `14b5aaf`, `00cdbf1`, `b713913`, `921aee0`, `10145dd` | One request per switch, bounded/aborted prefetch, draft and scroll restoration, no full reload or added SSE owner, retained switch state bounded |
| Transcript work | `fef446d`, `2011c44`, `bab7d91`, `284acb4`, `2d70075`, `6ed3a89`, `523a766` | Indexed lookup, lazy folds, Markdown cache, inserted-node highlighting, incremental append reconciliation, exact bounded projection checks |
| Recovery | `86791bd`, `ad32e78`, `0b215b7`, `4d2ed31` | 15-second heartbeat, freshness state, generation-safe authoritative recovery, exact draft preservation, focused multi-engine acceptance suite |
| Material and accessibility | `1f7170e` | Opaque content field, shared restrained chrome material, reduced-motion/transparency fallbacks, focus/target/zoom checks |
| Harness and budgets | `73dafe9`, `e909f16`, `0914c35` | Checked V3 results, cold/warm setup proof, request/byte/task boundaries, CDP/DOM/heap/server metrics, compatible comparator and provisional distribution gates |
| Generic question rendering | `0f4df97` | Generic `ask_user` prompts are surfaced in the session UI rather than remaining status-only |
| Integration policy closeout | `d5af1a4`, `802b5c0` | Recovery/highlighting adapter failures use typed Effect errors and schema decoding; full lint and formatting contracts restored |

## Compatible local samples

Runs:

- `rc-523a766-cold`: three isolated cold samples, nine checked JSON results.
- `rc-523a766-warm`: three isolated warm samples, nine checked JSON results.

Raw local results are under ignored `e2e/perf-results/` files whose names contain those run IDs.
They are schema V3 comparator inputs, not accepted baselines. Environment identity is Darwin
25.6.0 arm64, Node 22.22.2, Playwright 1.60.0, headless Chromium, 393×727 at DPR 2.75, and the
`unthrottled-local` V1 profile. CDP, forced GC, resource timing, and server metrics were supported.

Nearest-rank p95 equals max for three samples:

| Task | Cold median / p95 / max (ms) | Warm median / p95 / max (ms) |
|---|---:|---:|
| First home row | 83.4 / 89.1 / 89.1 | 40.8 / 43.4 / 43.4 |
| Project switch | 19.6 / 20.2 / 20.2 | 19.9 / 19.9 / 19.9 |
| Session switch | 49.0 / 51.6 / 51.6 | 46.0 / 47.0 / 47.0 |
| Ten pinned switches | 194.9 / 198.0 / 198.0 | 193.4 / 200.8 / 200.8 |
| Initial transcript tail | 374.9 / 378.9 / 378.9 | 314.6 / 320.4 / 320.4 |
| Load Earlier | 221.6 / 236.8 / 236.8 | 215.0 / 217.1 / 217.1 |
| Append 100 | 547.3 / 548.8 / 548.8 | 554.1 / 563.2 / 563.2 |
| Authoritative reconnect | 17.3 / 17.7 / 17.7 | 18.1 / 18.3 / 18.3 |

Every measured project/session/pin switch made one intended request. Ten warm and cold switch
cycles retained zero additional DOM elements, documents, or frames; forced-GC heap growth was at
most 2.21%, within the provisional 10% switch budget.

The original `924f075` samples use result schema V2 and different scenario contracts, so the V3
comparator correctly refuses to mix them with this set. As explicitly non-gating single-sample
context, current cold medians versus those old observations are: first row −15.9%, initial tail
−35.8%, Load Earlier −44.1%, and reconnect −17.9%. This is directional evidence, not a compatible
distribution comparison.

The final production app entry chunk is 217.33 KiB gzip, below the provisional 250 KiB target. The
1024px app icon is 122,840 bytes, below its 128 KiB regression limit.

## Correctness proof

Automated browser evidence completed during the slices:

- `make e2e-perf`: V3 switching, transcript/Load Earlier/append, and exact-once offline recovery.
- Connection resilience: 21 passes across all seven configured browser/device projects, covering
  SSE-only interruption, visibility return, authoritative append while disconnected, same-port
  restart, failed send, deliberate retry, unique IDs, and bounded stream counts.
- Transcript projection: 5,000-entry Desktop Chrome/Firefox/WebKit checks and a bounded 20,000-entry
  Chromium check; exact canonical/rendered IDs, find, selection, focus, screen-reader order, fold
  opening, and deep target checks.
- Mobile Load Earlier: Mobile Chrome and Mobile Safari preserve the first-window anchor within
  2 CSS px.
- Mobile home and accessibility suites cover actual bounded tracked-project behavior, 44px touch
  targets, focus names, 200% zoom, safe-area chrome, reduced motion, and reduced transparency.

CI now records five isolated cold samples after the E2E matrix and uploads the checked raw results
for 14 days. CI does not auto-accept a baseline. `make e2e-perf-record` defaults to twenty local
samples and five under CI; `make e2e-perf-compare` refuses incompatible environment identities and
only gates when `--baseline-accepted` is explicitly supplied.

## Evidence tiers

1. **Source reasoning:** implementation and unit/component contracts in the commits above.
2. **Automated browser proof:** Playwright assertions and JSON observations on this Mac.
3. **Chromium emulation:** the Pixel 5 profile supplies viewport/touch plus optional CDP
   throttling. It is not real-device CPU, radio, lifecycle, or thermal proof.
4. **WebKit correctness:** desktop WebKit with iPhone-sized projects proves engine/layout behavior;
   it does not supply fabricated CDP data and is not an iPhone benchmark.
5. **Real phone:** the user supplied an iPhone screenshot that exposed the pre-fix empty hierarchy.
   No post-fix timed five-task iPhone run and no Android run are recorded, so real-phone acceptance
   remains open.

## Known limitations and required acceptance work

- **Heavy 20k anchor:** one tool-heavy 20,000-entry Load Earlier measurement drifted about 2,468 px.
  The test records finite drift but does not falsely gate it at 2 px. Full all-window 5k/20k mounting
  also exceeded the test timeout. Bounded canonical projection remains correct.
- **Containment experiment rejected:** `content-visibility: auto` was not shipped. Dynamic intrinsic
  sizing produced roughly 43k–1.2M px jumps; fixed intrinsic sizing caused multi-minute stalls.
  Keeping opaque normal-flow render items was more correct.
- **Retained transcript metric:** the current retained snapshot spans Load Earlier plus append work,
  so its DOM/heap growth includes intentionally mounted history and cannot prove a ≤10% append-only
  slope. The switch-only retained metric is bounded.
- **Recovery realism:** visibility/background is browser-simulated, restart is graceful
  SIGTERM/relaunch on the same port, and send failure is injected at browser `fetch`. Real mobile
  suspension and an ungraceful server crash remain field checks.
- **Baseline decision:** the three-sample cold and warm sets establish candidate distributions but
  do not constitute human acceptance. A reviewer must retain the chosen raw run directory and
  explicitly use `--baseline-accepted` for later gates.
- **Phone study:** perform the five tasks in the research brief on current iPhone Safari and Android
  Chrome, recording completion, errors/mis-taps, taps, hesitation, confidence, ease, network, and
  thermal state.

Until the heavy 20k anchor behavior and real-phone study are accepted or explicitly waived, this is
an usable candidate rather than a claim that every V4/V7 release gate is complete.
