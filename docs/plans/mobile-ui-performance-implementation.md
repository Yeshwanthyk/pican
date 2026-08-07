---
shaping: true
status: accepted
owner: pican
updated: 2026-08-07
---

# Mobile UI and performance implementation plan

## Source

> “I want to redo the UI to make it fast … mostly concerned about using this on the phone.”

> “Pinned ones on the top … nice and clean and small.”

> “This is the kind of UI and aesthetic I’m looking at.”

The supplied reference is a matte, near-black activity list: compact two-line rows, bright task
titles, quiet metadata, small semantic icons, and simple time grouping. It is a density and
hierarchy reference, not a request to copy another product. The app icon must also be “extremely
tiny” on the wire.

The supporting source and current-system research is in
[mobile-ui-performance-harness.md](../research/mobile-ui-performance-harness.md).

## Outcome

On a phone, a person can see and enter pinned work immediately, move between projects with one
hand, continue a long coding session without UI stalls, and recover from a dropped or backgrounded
connection without losing a draft or seeing duplicate transcript entries. Every claim is backed by
a repeatable artifact from the performance harness and an RC check on real phones.

## Requirements

- **R0 — Phone-first density.** The home screen follows the reference hierarchy: Pinned, Now, then
  Projects; rows are compact, flat, and legible without card chrome.
- **R1 — Fast work switching.** Pinned work remains at the top in stored order. Status, project,
  runtime, and age are scannable; opening or switching work takes one primary gesture.
- **R2 — Preserve catalog contracts.** Continue using the bounded home response, project paging,
  stable soft-reload ordering, pin persistence, search, archives, and schedules. A visual redesign
  must not cause an unbounded browser payload.
- **R3 — Long-session responsiveness.** Initial open, Load Earlier, live append, scrolling,
  selection, copy, browser find, focus, anchors, and follow-to-bottom remain correct at 1.5k, 5k,
  and 20k representative entries.
- **R4 — Connection correctness.** Offline, background/resume, SSE interruption, and server
  restart converge to authoritative state exactly once. Typed drafts and scroll context survive.
- **R5 — Measured releases.** Named lab profiles produce versioned JSON with timings, long tasks,
  requests, transfer, DOM, heap, server metrics, fixture facts, and environment identity. Real
  phones remain a separate evidence tier.
- **R6 — Restrained glass and accessibility.** Glass is limited to persistent chrome and sheets,
  never the scrolling row field. Solid/reduced-transparency fallbacks, contrast, 44px targets,
  safe areas, reduced motion, keyboard use, and screen-reader names are required.
- **R7 — Preserve product boundaries.** Live SPA and export renders remain separate; routes,
  runtime support, session semantics, and user content are unchanged unless a slice explicitly
  changes their contract.
- **R8 — Reversible delivery.** Land vertical slices with focused tests and before/after artifacts;
  performance budgets are ratcheted only after three stable runs on one runner class.

## Selected shape

### A1. Make static delivery small

Keep the 1024px install icon contract, palette-optimize the PNG, and enforce a 128 KiB maximum in
the PWA test. Record static asset bytes in every home measurement. Then inventory the initial route
and introduce route-level dynamic imports only where measurement shows material savings. Do not
cache API or SSE traffic in the service worker.

### A2. Recompose home without changing its data model

Use the existing home payload and pin order. Replace card-like presentation with a flat activity
list:

- a quiet page label and compact action affordances;
- Pinned first, always expanded, with at most the viewport-fitting first set and a clear “All”
  affordance when necessary;
- Now second for running/waiting work not already represented;
- Projects third, with compact project headings and their curated recent rows;
- one two-line row: semantic icon, title, then status/context · project · age;
- status communicated by icon, text, and color, never color alone;
- desktop may breathe more, but it uses the same component and information order.

Keep primary row navigation, the 44px overflow action, touch prefetch, and the fixed phone thumb
bar. Deduplicate a touch prefetch and the ensuing navigation request rather than disabling useful
prefetch.

### A3. Reduce transcript work before adding virtualization

Make the cheapest correctness-preserving changes first:

1. replace per-tool linear entry scans with `SessionDataModel` lookup maps;
2. avoid parsing/rendering the body of closed activity folds until opened, while preserving its
   accessible summary and count;
3. cache parsed Markdown by stable entry identity/content revision;
4. scope syntax highlighting to newly inserted code nodes;
5. add `content-visibility: auto` and measured intrinsic sizes to stable entry groups;
6. make append reconciliation incremental where projections allow it.

Only proceed to windowed DOM virtualization if 20k-entry results remain outside the accepted
budget. Any windowing design must prove browser find, selection/copy, focus, deep anchors, Load
Earlier anchoring, screen-reader order, and live follow. It must retain canonical entries in the
model even when their DOM is not mounted.

### A4. Make connection freshness observable

Keep refetch-on-reconnect as the correctness mechanism. Add a small server SSE heartbeat with
explicit cadence, connection state/freshness in the client model, and a quiet reconnecting/stale
indicator only when action is useful. On `online`, visibility return, stream reopen, or detected
staleness, refetch and reconcile by identity. Never clear or replay composer text as part of
connection recovery.

One session page may own one session stream plus the existing global status stream. Tests assert
that toggling pinned navigation does not leak additional streams. If a transport interruption
occurs while sending, surface the failure and leave the exact draft available for deliberate retry.

### A5. Promote the harness from recorder to release signal

The first harness slice already provides deterministic catalog/transcript data, home, Load Earlier,
and offline recovery scenarios. Extend it with:

- cold and warm samples, five CI repetitions and twenty local comparison repetitions;
- a checked JSON schema and comparator with median/p95/max plus environment compatibility checks;
- request count and decoded/transfer byte attribution by resource;
- task marks for project switch, optimistic pin, session open, composer focus/type/send, pinned
  switch, append bursts, and scroll-to-bottom;
- Chromium CDP CPU/network/DOM/heap metrics, clearly labeled as emulation;
- WebKit correctness runs without fabricated CDP metrics;
- SSE-only interruption, background/resume, server restart, and typed-draft preservation;
- server `/api/metrics` snapshots before and after catalog/transcript scenarios.

Correctness gates apply immediately. Timing regression gates become required only after three
stable accepted baselines. Core Web Vitals targets remain standards-based; Pican task thresholds
are provisional until baselined.

### A6. Apply glass as chrome, not wallpaper

Define tokens for matte surface, elevated surface, hairline, muted text, active text, and status.
The scroll field stays opaque. The bottom thumb bar, pinned switcher sheet, and transient menus may
use one shared translucent material with a single blur layer. Under reduced transparency, lower-end
phone profiling, or unsupported browsers, switch to an opaque elevated surface. Avoid nested blur,
large animated shadows, gradients, and per-row compositing layers.

## Fit check

| Requirement | A1 | A2 | A3 | A4 | A5 | A6 |
|---|---:|---:|---:|---:|---:|---:|
| R0 Phone-first density |  | Pass |  |  | Measure | Pass |
| R1 Fast switching |  | Pass |  | Pass | Measure | Pass |
| R2 Catalog contracts |  | Pass |  |  | Pass |  |
| R3 Long sessions |  |  | Pass | Pass | Pass |  |
| R4 Connection correctness |  |  |  | Pass | Pass |  |
| R5 Measured releases | Pass | Measure | Measure | Measure | Pass | Measure |
| R6 Glass/accessibility |  | Pass | Pass | Pass | Pass | Pass |
| R7 Product boundaries | Pass | Pass | Pass | Pass | Pass | Pass |
| R8 Reversible delivery | Pass | Pass | Pass | Pass | Pass | Pass |

No requirement depends on a visual effect for correctness. “Measure” means the mechanism supplies
the evidence for that requirement; it is not a deferred fit.

## Breadboard

### Places

- **P1 Home:** compact mobile catalog and desktop adaptation.
- **P2 Session:** transcript, activity folds, pinned switcher, composer, connection state.
- **P3 Project/search sheet:** project navigation, search, and secondary actions.
- **P4 Performance runner:** deterministic server, browser profiles, measurements, artifacts, and
  comparisons.
- **P5 Server catalog/event plane:** summaries, projects, pins, paginated session API, SSE, metrics.

### Affordances and wiring

| Ref | Place | Type | Affordance / responsibility | Wiring |
|---|---|---|---|---|
| U1 | P1 | UI | Pinned heading and compact rows | reads S1; row tap N3; overflow N4 |
| U2 | P1 | UI | Now heading and live rows | reads S1/S4; row tap N3 |
| U3 | P1 | UI | Project headings and recent rows | reads S1/S2; expand/switch N2 |
| U4 | P1 | UI | Search/New/Menu thumb bar | opens P3 or existing creation/menu flow |
| U5 | P2 | UI | Contained transcript groups | reads S3; Load Earlier N6; append N8 |
| U6 | P2 | UI | Lazy activity summary/body | summary reads S3; open N7 |
| U7 | P2 | UI | Composer and send state | draft S5; submit existing RPC path |
| U8 | P2 | UI | Pinned switcher and freshness state | reads S1/S4; switch N3; retry N10 |
| U9 | P3 | UI | Search/project list/actions | query N2; selection N3/N4 |
| N1 | P1/P5 | code | Fetch bounded home catalog | `/api/sessions?view=home` -> S1 |
| N2 | P1/P3/P5 | code | Fetch/switch project or search | paged APIs -> S1/S2 |
| N3 | P1/P2/P3 | code | Prefetch and navigate once | prefetch cache -> paginated session -> S3 |
| N4 | P1/P3/P5 | code | Pin/archive actions | optimistic S1 -> API -> reconcile |
| N5 | P2 | code | Indexed tool/result and Markdown derivation | S3 maps/cache -> U5/U6 |
| N6 | P2/P5 | code | Load Earlier with scroll anchor | session window -> merge S3 -> restore U5 |
| N7 | P2 | code | Mount activity details on demand | selected fold -> N5 -> U6 |
| N8 | P2/P5 | code | Append delta incrementally | session SSE -> afterCount -> S3/U5 |
| N9 | P2/P5 | code | Heartbeat and freshness timer | SSE heartbeat/open/error -> S4/U8 |
| N10 | P2/P5 | code | Authoritative recovery | online/visible/open/stale -> refetch -> S1/S3 |
| N11 | P4 | code | Generate deterministic fixtures | seed/profile -> server files -> S6 |
| N12 | P4 | code | Observe and write measurements | browser/CDP/server metrics -> S7 |
| N13 | P4 | code | Compare compatible runs | S7 + accepted baseline -> report/gate |
| S1 | shared | store | Home summaries, pin order, stable display order | owned by SessionsPage/models |
| S2 | shared | store | Projects, tracking, search/pagination state | existing project state |
| S3 | P2 | store | Canonical session entries, tree, lookup maps, render cache | SessionDataModel |
| S4 | shared | store | Stream state, last event/heartbeat, recovery generation | connection models |
| S5 | P2 | store | Composer draft and send attempt state | session-scoped UI state |
| S6 | P4 | store | Fixture seed, counts, serialized bytes | result metadata |
| S7 | P4 | store | Versioned performance result/baseline JSON | ignored run artifact + reviewed baseline |

Critical paths:

`U1 row -> N3 deduped prefetch/navigation -> S3 -> U5 first message -> U7 enabled`

`SSE error -> N9 stale -> U8 reconnecting -> N10 authoritative refetch -> S3 exact merge -> U8 current`

`N11 fixture -> scenario -> N12 observations -> S7 -> N13 compatible comparison -> release decision`

## Vertical slices and commits

### V1 — Baseline and tiny transfer (this checkpoint)

**Implementation:** deterministic home/1.6k transcript fixtures; home, Load Earlier, and offline
recovery scenarios; JSON measurements; named mobile lab profile; `make e2e-perf`; optimized 1024px
icon with 128 KiB test.

**Demo:** run `make e2e-perf`, open the JSON artifact, and show resource attribution plus exact-once
recovery. Compare icon bytes before/after.

**Gate:** perf TypeScript check, three harness scenarios, `go test ./internal/ui`, `make check`.

### V2 — Compact Home visual system

**Files:** `SessionsList.svelte`, `SessionCard.svelte`, `SessionsPage.svelte`, index CSS, design tokens,
component tests, mobile index E2E.

**Implementation:** introduce semantic `ActivityRow`/`ActivityGroup` components; render Pinned, Now,
Projects; remove per-row card surfaces and redundant metadata; retain existing data partitioning,
actions, keyboard navigation, labels, and paging. Add solid and glass chrome tokens.

**Demo:** Pixel 5/iPhone 13 widths with 0, 1, 8, and 20 pins; running/waiting/completed/error states;
long titles; safe-area thumb bar; desktop comparison.

**Gate:** component accessibility/interaction tests, current index E2E updated to the real tracked
project contract, visual screenshots, home harness before/after with unchanged API result counts.

### V3 — Fast pin/project/session switching

**Files:** session prefetch cache/tests, pinned tabs/chips models, project navigation, perf scenarios.

**Implementation:** dedupe touch prefetch/navigation; bound or abort evicted prefetch work; preserve
pin order; expose project/search sheet; assert one intended session request and bounded SSE owners.

**Demo:** switch among ten pins and five projects on a phone without full document reload, duplicate
request, lost draft, or reset scroll context.

**Gate:** p50/p95 task marks, request/SSE counts, optimistic pin rollback test, ten-switch post-GC
DOM/heap slope.

### V4 — Long transcript containment

**Files:** `SessionDataModel`, `SessionContent`, `SessionEntry`, `ActivityFold`, `ToolCall`, Markdown
and highlighting helpers, pagination tests, transcript perf scenarios.

**Implementation:** indexed result lookup, lazy closed-fold body, cached Markdown, incremental
highlight/append work, then measured `content-visibility`. Keep each mechanism as a separately
reviewable commit. Do not add windowing until these results are known.

**Demo:** 1.5k/5k/20k light and heavy transcripts; initial open, all earlier windows, 1/10/100
appends, browser find/copy, fold open, deep anchor, and live follow.

**Gate:** exact transcript equality; <=2px Load Earlier anchor drift; no focus/selection regression;
long-task/DOM/heap comparisons recorded; cross-engine correctness passes.

### V5 — Mobile connection resilience

**Files:** server events, session/global connection models, status UI, metrics, unit/E2E/perf tests.

**Implementation:** periodic comment heartbeat; last-heartbeat/freshness state; generation-fenced
recovery refetch; quiet stale/reconnecting UI; test hooks or a scoped fault proxy for SSE drop and
server restart. Draft ownership remains outside recovery.

**Demo:** offline 10s, SSE-only drop 30s/120s, background/resume, append while disconnected, server
restart, and failed send. Each recovers exactly once and retains typed text.

**Gate:** authoritative equality, no duplicate IDs, expected stream count, reconnect/catch-up time,
draft byte-for-byte preserved.

### V6 — Glass, motion, and accessibility polish

**Files:** shared/index/session CSS, thumb bar/sheets/menus, accessibility and screenshot tests.

**Implementation:** one chrome material, opaque fallback, safe-area and keyboard handling, reduced
motion/transparency, contrast and focus treatment, icon/label optical alignment. Compare glass
on/off; remove the effect if it adds material scroll or interaction cost.

**Demo:** light/dark where supported, reduced motion/transparency, virtual keyboard, narrow phone,
zoomed text, VoiceOver/TalkBack task pass.

**Gate:** automated accessibility checks, no clipped controls at 200% zoom, touch targets >=44px,
no new >200ms task in provisional lab profile, real-phone scroll review.

### V7 — Ratchet and RC acceptance

**Files:** perf schema/comparator/baseline, CI artifact workflow, RC checklist and results.

**Implementation:** take three stable runs on one runner class, accept a reviewed baseline, enable
relative gates, and publish artifacts without mixing incompatible environments. Run the five human
tasks from the research on current and new UI, counterbalanced.

**Demo:** one report combines correctness, compatible lab deltas, and real iPhone/Android results,
while keeping each evidence tier visibly separate.

**Gate:** no correctness failures; accepted task budgets; mobile Core Web Vitals targets; no
unbounded retained DOM/heap; five human tasks completed without a critical navigation or freshness
failure.

## Initial budgets to baseline and ratchet

These are provisional engineering targets, not claims about current performance:

- home row count exactly matches the bounded response contract;
- initial app JavaScript <=250 KiB gzip and no >5% accepted-baseline regression;
- first pinned row p95 <1.5s warm / <3s cold on the named Pixel lab profile;
- project switch p95 <500ms; warm session first message p95 <1s;
- optimistic pin feedback <100ms; local authoritative convergence p95 <1s;
- next-paint interaction p95 <100ms and no task >200ms;
- online-to-authoritative catch-up p95 <3s in the local harness;
- retained heap/DOM growth after GC <=10% after ten switches or 100 appends;
- app icon <=128 KiB while remaining a valid 1024px PNG.

Record failures before changing a target. Budget updates require the result artifact, environment
identity, explanation, and reviewer acceptance.

## Release proof

For every slice, attach:

1. source commit and dirty-state declaration;
2. fixture seed, counts, bytes, browser/version/device profile, CPU/network profile, and cold/warm;
3. focused test output and JSON performance artifacts;
4. before/after screenshots for visual slices;
5. real-device make/model, OS/browser version, network condition, battery/thermal caveat, and the
   five-task result for RC;
6. explicit separation of source reasoning, local browser proof, emulation, and real-device proof.

This plan is complete when V7 accepts the compact UI as both easier to operate and measurably no
worse on the defined performance and recovery contracts.
