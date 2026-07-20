# Browser-local migration benchmark results

This log records the pinned control, candidate commit, run conditions, and
full-flow medians for each migration stage. A full flow sums the measured page,
synthesis, endpoints, cone, paths, and fanout durations within one trial. The
reported value is the median of those trial totals.

## Canonical Rust core extraction

- Date: 2026-07-17
- Control: `3ffd95ef4f6c6fdaa74f715dfb97d68d19313197`
- Candidate: `72cbb2f82737ce885120b70a357d963c794665e2`
- Browser: Chromium `148.0.7778.96`, headless
- Trials: five cold browser contexts, each followed by one warm reload
- Servers: release builds on the same host, separate empty design stores,
  driven sequentially
- Local Yosys: `0.64` for both servers

| Request latency | Browser state | Control median | Candidate median | Change |
| --- | --- | ---: | ---: | ---: |
| 0 ms | cold | 1298.66 ms | 1302.14 ms | +0.27% |
| 0 ms | warm | 1097.50 ms | 1101.91 ms | +0.40% |
| 150 ms | cold | 2812.33 ms | 2817.43 ms | +0.18% |
| 150 ms | warm | 2405.54 ms | 2397.92 ms | -0.32% |

Median request counts and transferred bytes matched in every measured phase.
The largest full-flow change was 0.40%, so the extraction passed its requirement
to preserve current behavior and performance within benchmark noise.

## Static browser-local cutover

- Date: 2026-07-17
- Control: `67c719a565bd944a469f500aa8ad122d18c91ca0` (current main)
- Candidate: `b93165ff7d0bd431cc6f94861aaf9149aec51fc1`
- Browser: Chromium `149.0.7827.55`, headless
- Trials: five fresh browser contexts, each followed by one warm reload
- Control: release Axum server, native Yosys 0.64, and a new empty design store
- Candidate: production Vite build served as static files, browser Yosys 0.67
- Host: same machine; targets were driven sequentially

The full-flow total includes page readiness, first synthesis, endpoints, an
endpoint cone, paths, and fanout. It deliberately excludes the separately
reported identical same-page synthesis cache hit.

| Request latency | Browser state | Main median | Static median | Change | HTTP requests main → static |
| --- | --- | ---: | ---: | ---: | ---: |
| 0 ms | cold | 1068.79 ms | 1820.99 ms | +70.4% | 14 → 7 |
| 0 ms | warm | 886.82 ms | 910.13 ms | +2.6% | 14 → 6 |
| 150 ms | cold | 2623.53 ms | 2498.10 ms | -4.8% | 14 → 7 |
| 150 ms | warm | 2410.15 ms | 1443.73 ms | -40.1% | 14 → 6 |

The cold zero-latency regression is real: native Yosys on the same host starts
faster than compiling, instantiating, and analyzing with browser WebAssembly.
The cutover is more responsive over a latency-bearing connection because the
remaining exploration flow no longer pays sequential API round trips. At 150 ms
on a warm reload, endpoint-to-cone fell from 984.87 ms to 89.74 ms and paths
from 205.20 ms to 61.82 ms.

### Per-browser cache hit

This phase clicks Synthesize again on the same unchanged design and waits for
Overview. Main hits its server cache but still performs an HTTP POST. The static
candidate hits IndexedDB, rebuilds the Rust WASM analysis session, and makes no
request.

| Request latency | Browser state | Main median | Static median | Change | Requests main → static |
| --- | --- | ---: | ---: | ---: | ---: |
| 0 ms | cold | 90.22 ms | 99.84 ms | +10.7% | 1 → 0 |
| 0 ms | warm | 110.54 ms | 99.17 ms | -10.3% | 1 → 0 |
| 150 ms | cold | 225.60 ms | 103.49 ms | -54.1% | 1 → 0 |
| 150 ms | warm | 243.51 ms | 105.13 ms | -56.8% | 1 → 0 |

The full browser E2E independently asserts that complete synthesis, cache reuse,
analysis, graph rendering, and source selection issue zero `/api` requests. The
candidate's HTTP counts above are static document, asset, and worker fetches;
they are not application API calls. Vite preview sends `Cache-Control: no-cache`,
so these local warm figures are conservative relative to the immutable asset
headers configured for Vercel.

## Live synthesis and reusable Yosys worker

- Date: 2026-07-18
- Control: live-auto-synthesis working tree immediately before worker reuse
- Candidate: the same working tree with streamed WASM compilation and reuse of
  completed workers
- Browser: Chromium `149.0.7827.55`, headless
- Design: the default generic-gates design followed by five source-comment edits
- Server: one production Vite build on localhost, with a fresh browser process
- Auto-synthesis idle window: 250 ms

The control and candidate were measured sequentially with the same script and
browser installation. Each source edit changed the cache key, so the five warm
runs exercised Yosys rather than IndexedDB. `Run` measures the UI's refreshing
state through the new current analysis; `edit to live` also includes the idle
window, editor event handling, and polling overhead.

| Phase | Disposable worker | Reused worker | Change |
| --- | ---: | ---: | ---: |
| Initial page to live analysis | 1241 ms | 1145 ms | -7.7% |
| Warm Yosys + analysis, median of five | 601 ms | 84 ms | -86.0% |
| Edit to live analysis, median of five | 978 ms | 381 ms | -61.0% |

The shipped comparison used for calibration, [HDL Studio](https://yosys-web-ide-development-9djj9k52c.vercel.app/),
waits 400 ms and keeps one worker alive. Its bundled adder measured 414 ms from
edit to synthesis start and 16 ms from start through render on this machine.
That is not an equivalent synthesis workload: its script stops after RTL
process cleanup and emits one netlist, while Synth Explorer emits source and
mapped netlists, supports seven modes, and initializes the Rust analysis engine.
Its Yosys resources total about 54 MiB; Synth Explorer's pinned Yosys WASM plus
resources total about 31 MiB.

The reusable-worker design retains stricter cancellation semantics than the
comparison: a completed worker stays warm, but an edit during synchronous Yosys
execution terminates it and starts a clean replacement. No stale run can block
the newest input from becoming canonical.

### Main versus live-auto branch

The migration harness was extended to drive both the permanent-button UI on
main and the automatic UI on this branch. Five fresh contexts with a warm reload
were run against local production builds of main and the branch. Main does no
initial synthesis; the branch deliberately includes an initial live result in
`page_ready`, so its full-flow totals include one additional synthesis.

| Request latency | Browser state | Main full flow | Live-auto full flow | Change |
| --- | --- | ---: | ---: | ---: |
| 0 ms | cold | 1535.90 ms | 1503.93 ms | -2.1% |
| 0 ms | warm | 898.69 ms | 1414.71 ms | +57.4% |
| 150 ms | cold | 2371.81 ms | 2512.09 ms | +5.9% |
| 150 ms | warm | 1450.10 ms | 1897.00 ms | +30.8% |

The warm full-flow regression is expected from that accounting: main reuses the
browser cache and waits for a click, whereas live-auto has already synthesized
the default design and then waits 250 ms before automatically processing the
selected example. For the interaction the feature is intended to improve,
main has unbounded edit-to-result latency until the user clicks; live-auto's
measured median is 381 ms with no click or synthesis request round trip.

## ELK worker prewarm

- Date: 2026-07-20
- Control: `e1c223bac4fb862ffdaef652ca1e780c02f80c6b`
- Candidate: the ELK-prewarm working tree described in this change
- Browser: Chromium `148.0.7778.96`, headless at 1440×900
- Builds: production Vite builds on separate localhost ports
- Trials: ten interleaved idle-path pairs at 480 nodes and five at 2,000 nodes;
  a separate choice experiment used five and three trials per condition
- Traffic: zero application API requests and zero failed requests

The harness rendered deterministic layered DAGs through the production-bundled
ELK module worker and the real React `GraphView`. It recorded compact projection,
worker startup, `elk.layout`, response, React commit, and a forced-layout
double-animation-frame visibility boundary. Every trial verified exact SVG node
and edge counts. The idle-path comparison deliberately completed prewarm before
the interaction, matching a user who remains on another analysis tab after a
result becomes current; it does not represent the default already-active
Schematic path.

The initial choice experiment measured construction-only separately from a
complete tiny layout. This is why the implementation spends the additional
worker CPU instead of only downloading and evaluating the module:

| Graph | Cold on demand p50 | Construction only p50 | Two-node prewarm p50 |
| --- | ---: | ---: | ---: |
| 480 nodes / 1,392 edges | 1383.7 ms | 1084.8 ms | 981.4 ms |
| 2,000 nodes / 3,960 edges | 3445.7 ms | 3184.9 ms | 2837.7 ms |

The larger paired idle-path validation produced the following medians and full
observed ranges. Ranges are reported instead of a near-cap p95 because five
trials are not enough to characterize tail latency.

| Graph | Cold on demand p50 (range) | Two-node prewarm p50 (range) | Change |
| --- | ---: | ---: | ---: |
| 480 nodes / 1,392 edges | 1367.4 ms (1344.6–1417.1) | 991.8 ms (973.7–1027.4) | -27.5% |
| 2,000 nodes / 3,960 edges | 3479.9 ms (3401.2–3530.6) | 2880.9 ms (2833.7–2929.1) | -17.2% |

The production-flow harness then started with a clean browser context, loaded
the real application, synthesized generated RTL, ran browser Rust analysis, and
waited for the default active Schematic to render exact counts. An
analysis-current trigger provided no defensible total-flow improvement: -0.1%
at 480 nodes and +0.4% at 2,000 nodes, because the real layout request followed
worker construction immediately. Starting at graph-surface mount instead
created a real warmup window:

| Graph | Trials | Cold total-to-visible p50 (range) | Mount prewarm p50 (range) | Change |
| --- | ---: | ---: | ---: | ---: |
| 480 nodes / 477 edges | 9 | 2606.6 ms (2569.6–2679.5) | 2257.3 ms (2191.4–2515.7) | -13.4% |
| 2,000 nodes / 1,997 edges | 5 | 5534.4 ms (5359.5–5586.9) | 5133.4 ms (5106.2–5446.0) | -7.2% |

At 480 nodes, mount prewarm added 26.2 ms (+2.1%) to the refreshing-to-current
phase while reducing current-to-visible by 375.1 ms (-39.9%). At 2,000 nodes it
showed no synthesis penalty and reduced current-to-visible by 314.9 ms (-14.7%).
Median total long-task time increased by 65 ms at 480 nodes and 13 ms near the
cap; maximum long-task duration increased by 16 ms and 25 ms respectively. The
end-to-end gain therefore includes a small, measured startup-contention cost
rather than treating prewarm CPU as free.

The isolated warmup consumed 355.6 ms p50 at 480 nodes and 347.8 ms near the cap
before the measured idle-path interaction. Its synchronous main-thread call was
under 1 ms, and the next two animation frames remained at about 20–22 ms. The
production trigger starts this work when the always-mounted graph surface
mounts, allowing module parsing and one-time ELK JIT work to overlap the initial
editor idle/debounce window without laying out the user design or changing its
geometry.

At warm steady state, `elk.layout` still accounts for about 87% of first-visible
latency. Compact TypeScript projection, cloning, graph preparation, adaptation,
both transfers, and hydration together measured 14.6 ms p50 at 480 nodes and
34.4 ms near the cap. The latter is only about 1.2% of the 2.88-second total, so
moving those phases to Rust would not materially improve this path. The next
measured candidate is lowering large-graph ELK thoroughness, which is tracked
separately because it changes layout shape.

## Schematic node-cap stress test

- Date: 2026-07-20
- Source: the production-built ELK-prewarm working tree
- Browser: Chromium `148.0.7778.96`, headless at 1440×900
- Trials: three per representative graph; one exploratory sparse-10,000 and
  dense-2,000 trial
- Traffic: zero application API requests, failed requests, and page errors

The cap experiment drove deterministic layered graphs through the complete
worker and real SVG render path. It retained the current 10-second layout
deadline and verified exact rendered node and edge counts. Memory is reported as
the renderer's RSS increase; it includes browser bookkeeping and is therefore a
coarse process-level measure rather than only the graph's JavaScript objects.

| Graph | ELK p50 | Visible p50 | Main-thread long tasks | Renderer RSS increase |
| --- | ---: | ---: | ---: | ---: |
| 2,000 nodes / 3,960 edges | 2.44 s | 2.93 s | 416 ms | 234 MiB |
| 3,000 nodes / 5,960 edges | 3.80 s | 4.51 s | 624 ms | 302 MiB |
| 5,000 nodes / 9,960 edges | 7.04 s | 8.14 s | 928 ms | 433 MiB |
| 10,000 nodes / 9,980 edges, sparse | 4.09 s | 5.71 s | 1.44 s | 601 MiB |

A separate dense 2,000-node / 9,900-edge probe needed 4.52 seconds to become
visible, approximately the representative 3,000-node result. Node count alone
is therefore not a sufficient safety budget. Five thousand representative
nodes already approach the layout deadline on a strong desktop and produce
about 150,000 DOM nodes; removing the cap would expose slower devices and dense
topologies to long freezes or timeouts.

The measured safe decision is to retain the hard 2,000-node cap. A later,
explicitly opt-in 3,000-node ceiling could be reconsidered only after ELK and
SVG-render improvements, with an additional edge budget of roughly 6,000 above
the current boundary. The existing 10,000-edge allowance can remain for views
at or below 2,000 nodes.

## Large-graph ELK and SVG optimization

- Date: 2026-07-20
- Control: `e3ddec98106cfb0323d9de4d1582c30170ef5e87`
- Browser: Chromium `148.0.7778.96`, headless at 1440×900
- Trials: seven interleaved production-build trials per synthetic graph and
  setting, plus four synthesized fixture topologies
- Traffic: zero application API requests or failed requests. ELK trials and the
  actual feature browser probe had zero page errors. The excluded synthetic pan
  injection produced the documented pointer-capture error after measured
  interactions.

ELK's default layered thoroughness is 7. Values 5 and 6 did not produce a
consistent speed or quality advantage. Thoroughness 4 was applied only to the
existing robust `BRANDES_KOEPF` path; `NETWORK_SIMPLEX` output for small graphs
was left unchanged.

| Graph | ELK default p50 (range) | ELK thoroughness 4 p50 (range) | Visible default p50 (range) | Visible thoroughness 4 p50 (range) |
| --- | ---: | ---: | ---: | ---: |
| 480 nodes / 1,392 edges | 925.4 ms (830.5–1003.5) | 798.5 ms (753.6–986.1), -13.7% | 1524.8 ms (1432.7–1603.4) | 1432.2 ms (1350.4–1593.9), -6.1% |
| 2,000 nodes / 3,960 edges | 2496.4 ms (2371.9–2585.9) | 2239.3 ms (2095.2–2364.2), -10.3% | 3463.8 ms (3282.0–3510.8) | 3206.0 ms (2987.2–3381.8), -7.4% |

All trials were deterministic within each setting and had zero fixed-port
endpoint mismatches. At 2,000 nodes, width, height, and bend count were
unchanged and the crossing count changed from 2,059 to 2,060. At 480 nodes,
width decreased 0.5%, height and bends were unchanged, and crossings decreased
from 13,528 to 13,520. Across four synthesized fixtures from 152 to 400 nodes,
thoroughness 4 reduced median ELK time by approximately 14–25%; dimensions and
bends were unchanged, with crossings identical or within 0.4%. No material
worker-memory regression was measured.

The SVG candidate removed the host `<g>` wrapper around every edge, stored
Focus relevance directly on the path and optional bus label, and memoized the
edge layer so node-only selection changes do not reconcile every edge. Paths,
titles, markers, bus labels, geometry, and exact edge counts were preserved.

| Metric | 480 nodes / 1,392 edges | 2,000 nodes / 3,960 edges |
| --- | ---: | ---: |
| React render and commit | 136.3 → 124.2 ms (-8.9%) | 333.9 → 299.9 ms (-10.2%) |
| Commit to visible | 30.2 → 28.7 ms (-5.0%) | 114.1 → 102.8 ms (-9.9%) |
| Node selection visible | 46.2 → 37.4 ms (-19.0%) | 111.0 → 83.6 ms (-24.7%) |
| SVG elements | 6,550 → 5,158 (-21.3%) | 21,846 → 17,886 (-18.1%) |
| DOM nodes | 19,189 → 17,797 (-7.3%) | 59,581 → 55,621 (-6.6%) |

At 2,000 nodes, browser task time fell 10.4%, script time 21.5%, style time
15.1%, and layout time 5.6%. Retained heap growth fell from 24.88 MiB to
18.93 MiB and aggregate retained Chromium RSS growth from 240.4 MiB to
230.0 MiB. Paint timing was flat and noisy, so these results establish React,
DOM construction, style, and layout gains rather than a rasterization gain.
Removing per-node ref callbacks was also tested separately and did not produce
a reliable improvement.

These optimizations improve the existing bounded viewer but do not by
themselves justify raising the 2,000-node cap. The delegated-interaction and
zoom-level detail stages measured next retain that bound as well.

## Delegated schematic interactions

- Date: 2026-07-20
- Control: `ff9ac81bf3fccdcc19c26a2e1f6d7a9677fc3991`
- Browser: Chromium `148.0.7778.96`, headless at 1440×900
- Trials: seven alternating production-build trials per graph and variant
- Traffic: zero application API requests, failed requests, console errors,
  page errors, and assertion failures

The candidate removed seven function-valued React event props and two local
state hooks from every schematic node. Click, double-click, focus, and keyboard
actions are handled at the SVG boundary; four native viewport listeners update
a small pin-label overlay for the unique selected, hovered, or focused nodes.

| Metric | 480 nodes / 1,392 edges | 2,000 nodes / 3,960 edges |
| --- | ---: | ---: |
| Per-node React handler props | 3,360 → 0 | 14,000 → 0 |
| CDP listener records | 1,150 → 194 (-83.1%) | 4,190 → 194 (-95.4%) |
| Initial retained heap | 5.83 → 5.43 MiB (-6.9%) | 17.77 → 16.18 MiB (-9.0%) |
| Click to selected | 108.3 → 108.0 ms (-0.3%) | 383.0 → 336.1 ms (-12.2%) |
| Hover to pins visible | 8.2 → 10.6 ms | 13.5 → 13.9 ms |

React's root delegation remained at 139 native registrations in both variants.
The old nodes had one native click listener each, not seven native listeners;
the other per-node handlers were React props. The CDP listener-record metric
includes React and browser records and is therefore reported separately from
native-listener attribution.

All 28 trials preserved exact node, edge, DOM, SVG, geometry, role, accessible
label, and roving-tab-stop contracts. Hover/focus pins, selection, expansion,
control actions, keyboard navigation, and real pointer pan also passed. The
no-selection DOM was unchanged. Visible pins add at most three transient
wrapper elements, and the renderer bundle increased 1,522 bytes raw and 319
bytes gzip. Aggregate and renderer RSS were effectively flat.

Initial render timings were noisy under concurrent Chromium load: the
2,000-node median was directionally faster, while the 480-node median was
slower. No general initial-render or hover-speed claim is supported. The
repeatable benefit is constant interaction-listener state and lower retained
JavaScript heap at the existing cap.

### Zoom-level detail culling

The LOD candidate stored one imperative `data-detail-level` on the SVG viewport
instead of keeping zoom scale in React state. Overview detail below nominal
scale 0.40 hides unreadable node text, operator/control/register labels, bus
labels, and decorative symbol detail. Compact detail from 0.40 to 0.75 restores
primary labels and glyphs; full detail at 0.75 and above restores everything.
Hysteresis uses 0.35/0.45 and 0.65/0.80 boundaries, and richer detail returns
after 160 ms of zoom inactivity. Selected and focused nodes always restore
their labels, register pins, and controls. Outlines, edge paths, arrows, titles,
and transient pin overlays remain at every level.

Three fresh-context initial-render trials per variant and nine interleaved
motion samples per 480/2,000-node fixture produced these medians:

| 2,000-node metric | Full | Compact | Overview |
| --- | ---: | ---: | ---: |
| React render and commit | 1,630.3 ms | 1,387.6 ms (-14.9%) | 1,249.3 ms (-23.4%) |
| Commit to visible | 742.8 ms | 416.1 ms (-44.0%) | 222.1 ms (-70.1%) |
| Main task | 3,151.2 ms | 2,357.0 ms (-25.2%) | 2,290.5 ms (-27.3%) |
| Layout | 978.6 ms | 438.2 ms (-55.2%) | 471.2 ms (-51.8%) |
| Ten-frame fit motion | 3,227.6 ms | 1,745.7 ms (-45.9%) | 981.3 ms (-69.6%) |
| Aggregate RSS delta | 250.7 MiB | 227.4 MiB (-9.3%) | 218.1 MiB (-13.0%) |

At 480 nodes, fit motion fell 44.8% in compact mode and 65.0% in overview.
Every tier retained the same DOM and SVG nodes, geometry, paths, arrow markers,
titles, hit targets, and JavaScript heap. `display: none` produced the sustained
gain; `visibility: hidden` improved motion only 28.1%, and `opacity: 0` only
3.3%. Removing arrows was neutral or worse and lost explicit direction.

A sparse 3,000-node / 5,960-edge overview probe reduced renderer commit plus
visible time 46.7%, long-task total 46.3%, selection 46.9%, zoom 74.8%, and
page/process RSS growth 18.0%. It still took 10.34 seconds to become visible,
had an 814 ms largest main-thread task, retained 33,017 SVG and 50,857 DOM
elements, and used approximately 1.03 GiB across Chromium processes. This is
not dense-edge safety evidence. `MAX_SUBGRAPH_NODES` and
`MAX_GRAPH_RENDER_NODES` therefore remain 2,000; removing either cap is rejected.
