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
