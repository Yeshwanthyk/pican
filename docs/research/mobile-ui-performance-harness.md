# Mobile UI and performance harness research

Implementation sequencing, affordance wiring, gates, and commit-sized slices are defined in
[the mobile UI and performance implementation plan](../plans/mobile-ui-performance-implementation.md).

Research date: 2026-08-07

This brief distinguishes current Pican behavior, primary-source platform facts, and a proposed
measurement/design direction. The repository evidence is from commit `d12fbfa`; the existing dirty
`package.json` and `package-lock.json` were not changed. External claims link directly to the
standard or first-party documentation that owns them.

## Bottom line

Pican should make the phone home screen a compact project switcher with one always-visible pinned
group, then treat glass as restrained chrome rather than a material applied to every row. The data
path does not need to be reinvented first: the default home response is already bounded to every
pin and at most six sessions per tracked project, while other views paginate in pages
of 100 ([frontend architecture](../architecture/frontend.md#sessions-index-),
[`SessionsPage.svelte`](../../web/src/routes/SessionsPage.svelte#L45-L45),
[`SessionsPage.svelte`](../../web/src/routes/SessionsPage.svelte#L134-L161)). The first work should
make that contract visible, compact, and measurable.

Performance work needs two complementary loops:

1. A deterministic Playwright lab harness compares commits on fixed session catalogs, long
   transcripts, update rates, viewports, and connection interruptions.
2. A small opt-in local telemetry surface records real phone Core Web Vitals and Pican-specific task
   timings. Lab tests catch regressions before release; field measurements reveal real device,
   network, browser-lifecycle, and interaction costs that lab emulation cannot reproduce.

Do not set a pass/fail gate from a single laptop run. Establish a versioned baseline first, collect
at least 20 cold and 20 warm lab samples per scenario, use medians for routine comparison and p95
for regressions, then adopt budgets. Core Web Vitals remain the external guardrails: good LCP is at
most 2.5 s, INP at most 200 ms, and CLS at most 0.1 at the 75th percentile, segmented by mobile and
desktop ([Web Vitals](https://web.dev/articles/vitals)).

## Confirmed current Pican behavior

### Home already prioritizes projects and pins

- `/` is a Svelte 5 page with Projects as the default scope, plus All Sessions, Archived, and exact
  project views ([frontend architecture](../architecture/frontend.md#sessions-index-)).
- `view=home` returns every unarchived pinned session and at most six sessions for each explicitly
  tracked project. Pinned order is stable SQLite `pinOrder`, including when a session is running or
  waiting. Unpinned sessions from untracked projects remain available in All Sessions
  ([frontend architecture](../architecture/frontend.md#sessions-index-)).
- The page requests 100 sessions for All/Archived/project scopes, adds subsequent pages, and does
  not paginate the already-bounded home response
  ([`SessionsPage.svelte`](../../web/src/routes/SessionsPage.svelte#L45-L45),
  [`SessionsPage.svelte`](../../web/src/routes/SessionsPage.svelte#L93-L93),
  [`SessionsPage.svelte`](../../web/src/routes/SessionsPage.svelte#L134-L169)).
- Pointer/touch intent can prefetch a session. The client bounds that in-flight cache to 16 entries
  and asks for the paginated transcript form
  ([`SessionCard.svelte`](../../web/src/components/index/SessionCard.svelte#L83-L85),
  [`session-prefetch.ts`](../../web/src/routes/session-prefetch.ts#L10-L27)).

This supports a compact home hierarchy without adding another catalog endpoint:

1. **Pinned**: a compact top group, ordered exactly as the server returns it.
2. **Projects**: dense project rows showing project name, active/waiting counts, and a small recent
   session preview; expand one project at a time on phone.
3. **Search / all sessions**: an explicit secondary path, not the initial phone payload.

### Long transcripts are windowed, but DOM work can still grow

The normal large-session threshold is 1,500 entries; the initial response keeps the latest 1,000
entries. “Load earlier” prepends 500 entries at a time and reconciles the combined entry array
([`session_page.go`](../../internal/ui/session_page.go#L40-L45),
[`handlers.go`](../../internal/server/handlers.go#L513-L526),
[`LoadEarlier.svelte`](../../web/src/components/session/LoadEarlier.svelte#L30-L74)).

There is already functional E2E coverage for this contract, but it is not a performance test. Its
fixture lowers the threshold to 100 and tail to 50 because the former 1,600-message case flaked
under parallel CPU contention, and the spec explicitly notes that merged-conversation re-rendering
can jam the main thread ([E2E server](../../e2e/lib/server.ts#L102-L109),
[`load-earlier.spec.ts`](../../e2e/tests/load-earlier.spec.ts#L4-L12),
[`load-earlier.spec.ts`](../../e2e/tests/load-earlier.spec.ts#L74-L83)).

That is evidence for a measurement target, not proof that virtualization is immediately required.
First measure initial tail render, each 500-entry prepend, deep navigation, find/copy/focus, and live
append at realistic entry complexity. If off-screen rendering dominates, test per-entry or
per-turn `content-visibility: auto` with a stable `contain-intrinsic-size`. The CSS Containment
specification permits the user agent to skip off-screen layout and paint while keeping
`content-visibility: auto` content semantically relevant, and specifically recommends fine-grained
use for long lists; it also warns that incorrect intrinsic sizing can cause scroll jumps
([CSS Containment Level 2](https://www.w3.org/TR/css-contain-2/#using-cv-auto)). Preserve Pican's
find-in-page, focus, selection, anchor restoration, and accessibility behavior in the experiment.
Only move to DOM virtualization if containment misses the budget, because virtualization has a
larger correctness surface for variable-height Markdown, disclosures, selection, find, anchors,
and live follow.

### Live state already catches up, but liveness is not yet proven under phone suspension

The session stream listens for canonical reload, preview, and worker-status events; the global
stream carries new-session/status/curation updates
([frontend architecture](../architecture/frontend.md#live-reload)). Session reconnect uses capped
exponential backoff plus jitter, reloads after reconnect, and refreshes on visibility return or the
browser `online` event
([`live-connection.ts`](../../web/src/session/live/live-connection.ts#L42-L48),
[`live-connection.ts`](../../web/src/session/live/live-connection.ts#L103-L156)). The global stream
closes on `pagehide`, reconnects on `pageshow`, and the Sessions page refetches its scoped catalog
after a reconnect ([`status-events.ts`](../../web/src/shared/status-events.ts#L63-L95),
[`status-events.ts`](../../web/src/shared/status-events.ts#L141-L148),
[`SessionsPage.svelte`](../../web/src/routes/SessionsPage.svelte#L344-L373)). The server immediately
flushes an initial comment and, for the global topic, a status snapshot
([`events.go`](../../internal/server/events.go#L24-L43)). It coalesces replaceable pending events and
relies on snapshots/refetches for self-healing after loss or backpressure
([`server.go`](../../internal/server/server.go#L544-L582)).

Two gaps belong in the harness:

- the server sends an initial `:ok` but no periodic heartbeat in the current event loop
  ([`events.go`](../../internal/server/events.go#L32-L65));
- no current performance/resilience suite proves background/suspend, a half-open connection,
  offline/online recovery, recovery latency, or “no duplicate/lost visible state” across mobile
  engines.

The HTML standard says EventSource normally reconnects after closure, carries the last event ID in
`Last-Event-ID` when one exists, accepts a server-provided `retry` delay, and can be told to stop via
HTTP 204 ([HTML server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)).
It also recommends a comment line about every 15 seconds to survive legacy proxy timeouts
([SSE authoring notes](https://html.spec.whatwg.org/dev/server-sent-events.html#authoring-notes)).
Pican's snapshot/refetch recovery can remain the correctness mechanism, but a bounded heartbeat and
explicit connection-age/recovery measurements would make stale half-open phone sessions observable.
Chrome's lifecycle guidance also says mobile pages may become hidden, frozen, resumed, or restored,
and that `visibilitychange` is often the last reliably observable transition; `pageshow` identifies
restoration ([Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)).

## Mobile UI direction: compact, legible, restrained glass

### Supplied visual direction

The user-provided reference is a flat, near-black activity list rather than a card dashboard. Its
useful traits for Pican are the two-line row rhythm, bright task title, quiet secondary metadata,
small semantic leading icon, and grouping label as the primary structure. Translate that into
Pican as follows:

- keep project and session rows borderless and visually flat;
- use the first line for the task/session title and the second for state, project, runtime, or
  diff/tool metadata;
- let status icons and restrained semantic color carry scan value without turning every row into a
  badge collection;
- use spacing and group labels for hierarchy instead of nested cards; and
- reserve translucency for the pinned/header/composer chrome that stays fixed around the list.

This reference sharpens the proposal below: “compact glass” means a matte activity surface framed
by restrained glass chrome, not glass cards.

### Information architecture

The smallest useful phone home is:

```text
Pican                         Search  +

Pinned
        task title                    status
        current action · project

Projects
        project-a                  2 active
        latest task · 4m
        project-b                     quiet

                 Search       New       Menu
```

- Keep a compact pinned group visible at the top using the same two-line row language as the
  supplied reference. Show the first few pins without horizontal scrolling and keep the complete
  ordered set in the existing pinned-session sheet/search path. Each item needs project, session
  title, and a status cue; do not duplicate pins again inside project sections.
- Make project rows the primary navigation unit. One tap opens its recent sessions; a second tap
  opens a session. Preserve one-thumb access to search/new/menu in the existing bottom bar.
- Use density through typography and alignment, not through tiny targets. WCAG 2.2's Level AA
  minimum pointer target is 24 by 24 CSS pixels or sufficient spacing, and its guidance recommends
  larger targets for important controls
  ([Understanding Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)).
  Pican's existing design contract already uses 44 px mobile control heights; retain that hit area
  even when the visible chip looks smaller ([design system](../design/design-system.md#plain-states)).
- Keep project/session identity textual. Status color is supplementary, never the sole distinction.

### Glass rule

Use glass only on persistent chrome: top header, pinned strip container, bottom thumb bar, and
modal/sheet headers. Keep transcript entries and project/session rows opaque or nearly opaque. This
creates the requested cohesive glass frame without multiplying blur layers behind every scrolling
row.

Pican currently applies 16 px backdrop blur to the index header, mobile thumb bar, session header,
and several sheets/popovers
([`index.css`](../../internal/ui/embedded/styles/index.css#L33-L41),
[`index.css`](../../internal/ui/embedded/styles/index.css#L1913-L1929),
[`session.css`](../../internal/ui/embedded/styles/session.css#L1114-L1130)). WebKit's own backdrop
filter description says the effect requires extra rendering passes and should be used only where
necessary ([Introducing Backdrop Filters](https://webkit.org/blog/3632/introducing-backdrop-filters/)).
Therefore the harness must compare glass on/off while scrolling and streaming, rather than assuming
hardware acceleration makes it free.

Use these constraints for the redesign experiment:

- one overlapping blurred layer per screen region; avoid nested backdrop filters;
- no blur on a full long-scrolling transcript surface;
- no continuous shimmer, animated blur radius, or large shadow animation;
- define an opaque fallback first, then enhance inside `@supports (backdrop-filter: blur(1px))`;
- honor both `prefers-reduced-motion: reduce` and
  `prefers-reduced-transparency: reduce`. Media Queries Level 5 defines reduced transparency as a
  request to minimize transparent/translucent layer effects
  ([Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/#prefers-reduced-transparency));
- under reduced transparency, remove backdrop filters and use a solid theme surface plus explicit
  border. Apple describes Reduce Transparency as improving contrast and legibility by reducing
  transparency and blur effects
  ([Apple accessibility testing](https://developer.apple.com/documentation/accessibility/testing-system-accessibility-features-in-your-app));
- validate actual composited text/background combinations. WCAG 2.2 requires 4.5:1 for normal text
  and 3:1 for large text
  ([WCAG 2.2 contrast](https://www.w3.org/TR/WCAG22/#contrast-minimum)).

## Proposed performance and resilience harness

### Artifact shape

Add a separate `e2e/perf/` suite rather than timing assertions inside functional specs:

```text
e2e/perf/
  fixtures.ts              deterministic catalog/transcript generators
  observer-init.ts         PerformanceObserver + Pican mark collection
  scenarios.spec.ts        home/project/session/transcript task journeys
  resilience.spec.ts       offline, resume, dropped SSE, burst recovery
  chromium-throttle.ts     optional CDP network/CPU profile
  budgets.json             versioned budgets after baseline is accepted
  report.ts                JSONL samples + Markdown comparison
```

Run performance projects serially with a dedicated server and no functional-test contention. Store
raw samples as an artifact; derive medians, p75, and p95 in the report. Keep screenshot/ARIA
snapshots as separate correctness evidence. Playwright warns that screenshot rendering varies by
OS, browser, hardware, power source, and headless mode, so baselines must come from a pinned
environment ([Playwright visual comparisons](https://playwright.dev/docs/test-snapshots)).

The repository already runs Chromium, Firefox, WebKit, Pixel 5, iPhone 13, and iPad-emulated
projects, but its own documentation correctly says these are desktop-engine/device emulations, not
literal phones ([E2E testing](../dev/e2e-testing.md#project-matrix),
[`playwright.config.ts`](../../e2e/playwright.config.ts#L20-L29)). Playwright's device descriptors
set viewport, user agent, screen size, and touch behavior
([Playwright emulation](https://playwright.dev/docs/emulation#devices)). Use that matrix for layout
and cross-engine correctness, then retain a small real-device acceptance run on current iPhone
Safari and an Android Chrome phone for release candidates.

### Instrumentation

Install an init script before application code and gracefully collect only supported performance
entry types:

- navigation timing: response start, DOM milestones, load end;
- paint/LCP and layout shifts;
- event timing grouped by `interactionId` for real interactions;
- long animation frames or long tasks when supported;
- resource request count, transfer size, and decoded body size;
- Pican marks: `home-data-ready`, `home-interactive`, `project-open-painted`,
  `session-tail-painted`, `load-earlier-painted`, `live-update-painted`, `sse-open`,
  `sse-recovered`, `authoritative-catch-up`;
- per-checkpoint DOM element count and visible transcript-entry count;
- response byte counts for `/api/sessions`, `/api/session`, and streamed event data;
- Chromium-only diagnostics such as JS heap and CDP trace/CPU categories, clearly labeled so they
  are never mistaken for cross-engine Web APIs.

Event Timing exposes dispatch, processing, and next-paint duration and groups related events with
`interactionId`, the basis for INP
([Event Timing API](https://www.w3.org/TR/event-timing/)). Long Animation Frames identifies UI-thread
work over 50 ms and includes rendering-phase timing
([Long Animation Frames](https://www.w3.org/TR/long-animation-frames/)). LCP is a document-load
metric and does not reset for same-document SPA navigation, so project/session route tasks need
Pican-specific marks in addition to LCP
([Largest Contentful Paint limitations](https://www.w3.org/TR/largest-contentful-paint/#limitations)).

Field telemetry should use the small official `web-vitals` API or equivalent standards-based
observers and retain only aggregate timings, route/scenario, browser family, coarse viewport/device
class, and build version—never transcript text, session names, filesystem paths, IDs, prompts, or
tool output. The official guidance recommends field measurement because device, network, other
processes, and user behavior materially affect results; Lighthouse cannot measure INP without user
input and uses TBT only as a lab proxy ([Web Vitals](https://web.dev/articles/vitals#lab-tools-to-measure-core-web-vitals)).

### Required scenario matrix

| Scenario | Fixture / action | Primary measures | Correctness invariant |
|---|---|---|---|
| Cold home | 25 projects, 10 tracked, 20 pins, 1,000 total sessions | LCP, JS/transfer bytes, home-data-ready, DOM count | every pin and bounded tracked-project preview appears in stable order |
| Warm home | revisit through SPA and browser back | project-open-painted, resource count, CLS | scroll/focus and current scope remain usable |
| Pinned switch | tap first, middle, last pin; prefetched and not prefetched | tap-to-session-tail-painted, INP/event duration | correct runtime/session; no stale transcript flash |
| Project switch | open 10 project groups and one exact-project page | interaction duration, long frames, DOM growth | only intended group/scope changes |
| Initial long transcript | 1,500, 5,000, and 20,000 mixed-complexity entries | parse/data/render split, long frames, DOM/heap | latest tail, anchors, composer, find/copy remain correct |
| Load earlier | prepend repeated 500-entry windows | fetch-to-painted, max frame, scroll-anchor drift | first visible entry stays visually anchored |
| Live transcript | 1, 5, and 20 updates/s for 60 s, simple and tool-heavy | update-to-paint, long frames, DOM/heap slope | order, follow mode, focus and controls remain correct |
| Glass stress | scroll home/transcript with glass enabled/disabled | frame/paint time, dropped-frame proxy, power/thermal real-device note | no contrast/focus/layout regression |
| Offline recovery | online → offline 10/60 s → online | detection and sse-recovered time, request count | no duplicate optimistic action; authoritative state catches up |
| Background resume | hide/freeze or background phone for 1/5/15 min | resume-to-authoritative-catch-up | pin/status/transcript/worker state become current |
| Burst/backpressure | suppress delivery, emit many keyed updates, restore | recovery time and bytes | final snapshot matches server; no permanent stale status |
| Accessibility | reduce motion/transparency, 200% text, keyboard/screen reader smoke | task completion and visual snapshots | solid fallback, no clipped text, focus order/labels preserved |

Use generated fixtures with fixed random seeds and a declared complexity mix: plain text, Markdown,
code blocks, tool calls, large collapsed tool output, diffs, images as metadata-only and loaded,
thinking folds, questions, and streaming preview. Record both entry count and serialized bytes;
“5,000 entries” alone does not describe render cost.

### Network and CPU profiles

Use three layers and label them precisely:

1. **Cross-browser correctness:** Playwright device projects plus `context.setOffline(true/false)`
   for hard disconnect/reconnect. Playwright officially supports offline emulation
   ([Playwright BrowserContext](https://playwright.dev/docs/api/class-browsercontext#browser-context-set-offline)).
2. **Chromium lab performance:** a CDP session applies a pinned latency/throughput and CPU slowdown
   profile, with unthrottled and throttled samples. Playwright documents raw CDP sessions and notes
   they are Chromium-only
   ([Playwright CDPSession](https://playwright.dev/docs/api/class-cdpsession),
   [BrowserContext `newCDPSession`](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session)).
3. **Real phones:** release-candidate runs on iPhone Safari and Android Chrome over Wi-Fi plus a
   constrained network. Chrome says desktop device mode and CPU throttling are first-order
   approximations, relative to the host, and cannot reproduce a mobile CPU architecture
   ([Chrome device mode](https://developer.chrome.com/docs/devtools/device-mode),
   [Performance panel throttling](https://developer.chrome.com/docs/devtools/performance/reference#throttle-the-cpu-while-recording)).

Pin the CDP profile values in `budgets.json` and name them as harness profiles, not “real 4G” or
“real iPhone.” Calibrate on one CI runner class and do not compare absolute samples across unlike
machines.

### Baseline first, then budgets

The following are proposed adoption gates, not current measurements:

- no correctness failure in any scenario;
- Core Web Vitals field target: p75 mobile LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1;
- lab regression gate after baseline: median no worse than 10% and p95 no worse than 20% for each
  named Pican task, unless the PR carries an accepted budget update;
- no individual interaction/render long frame over a provisional 200 ms on the normal mobile
  profile; report every frame over 50 ms for diagnosis;
- load-earlier scroll anchor drift <= 2 CSS px after settle;
- offline/background recovery reaches an authoritative catalog/session state within 5 s of a
  successful SSE open on localhost/Wi-Fi harness conditions;
- steady-state live streaming shows no unbounded DOM-node or heap slope after the retained
  transcript window is stable.

The 10/20%, 200 ms, 2 px, and 5 s values are engineering starting points and must be ratified from
baseline distributions and observed phone use. Only the Core Web Vitals thresholds above come from
the external standard program.

## Human task study

Automation cannot answer whether project switching feels obvious. Run a five-task moderated phone
study against the current UI and the compact prototype:

1. Open a named pinned session and identify whether it is running or waiting.
2. Move to a named project, find its latest task, and continue coding.
3. Switch to another pinned task and return without losing the draft/scroll context.
4. Background the phone, return after one minute, and decide whether the visible state is current.
5. Find an early message in a long transcript, copy part of it, then return to the latest message.

Capture completion, error/mis-tap count, taps, first hesitation, perceived connection confidence,
and post-task ease (single 1–7 score). Screen-record only with consent and use sanitized fixtures.
The target comparison is within-subject current versus prototype, counterbalanced to limit learning
effects. The harness supplies exact event timestamps; observation supplies the why.

## Recommended vertical slices

1. **Measurement without redesign.** Add deterministic perf fixtures, marks, JSONL reporting, and
   cold/warm home plus initial/load-earlier transcript scenarios. Record the baseline at `d12fbfa`.
2. **Connection proof.** Add offline/background/burst tests, connection-age instrumentation, and a
   bounded server heartbeat experiment. Prove final authoritative equality, not merely that an
   `open` event fired.
3. **Compact phone home.** Recompose the existing bounded response into Pinned and Projects;
   preserve current pin order, project curation, search, and pagination APIs. Compare human tasks
   and lab metrics to baseline.
4. **Restrained glass.** Apply glass only to chrome, add solid/reduced-transparency fallbacks, and
   run glass on/off paint/scroll comparisons on Chromium, WebKit emulation, and real iPhone Safari.
5. **Transcript containment experiment.** Apply fine-grained `content-visibility: auto` with stable
   intrinsic sizes behind an experiment flag. Measure anchors, selection/find/focus, live follow,
   and screen-reader semantics before considering full virtualization.

This order makes performance a release criterion while keeping each change attributable. A faster
new layout that silently weakens reconnect correctness, transcript navigation, or accessibility is
not an improvement.
