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
