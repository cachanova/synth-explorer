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
