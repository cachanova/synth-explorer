# Browser migration benchmark

This harness compares a pinned control commit with the current candidate by
driving the real production UI in Chromium. It measures browser-cold and warm
flows at localhost latency and with 150 ms of artificial request latency.

## Prepare the two builds

Create a detached control worktree at the commit recorded in
`docs/BROWSER_WASM_MIGRATION.md`. Build both frontends with `npm ci` and
`npm run build`. Start each Rust server with a distinct port, static directory,
and empty design-store directory. For example:

```bash
BIND_ADDR=127.0.0.1:8787 \
STATIC_DIR=/absolute/path/to/control/web/dist \
DESIGN_STORE_DIR=/tmp/synth-explorer-control-designs \
cargo run --manifest-path /absolute/path/to/control/server/Cargo.toml --release

BIND_ADDR=127.0.0.1:8788 \
STATIC_DIR=/absolute/path/to/candidate/web/dist \
DESIGN_STORE_DIR=/tmp/synth-explorer-candidate-designs \
cargo run --manifest-path /absolute/path/to/candidate/server/Cargo.toml --release
```

Use new, empty design-store directories for a cold backend comparison. Do not
run unrelated CPU- or memory-heavy work during the benchmark.

## Run

From the candidate's `web/` directory:

```bash
npm run benchmark:migration -- \
  --control http://127.0.0.1:8787 \
  --control-revision 0123456789abcdef0123456789abcdef01234567 \
  --candidate http://127.0.0.1:8788 \
  --candidate-revision 89abcdef0123456789abcdef0123456789abcdef \
  --trials 5 \
  --output /tmp/browser-migration-result.json
```

The harness runs the targets sequentially. Each trial uses a fresh browser
context for its cold pass, then reloads that context for its warm pass. The
result includes raw samples and median, p95, minimum, and maximum values for
duration, HTTP traffic, failed requests, and renderer JavaScript heap use.

The initial harness measures user-visible boundaries: page ready, synthesis to
Overview, endpoints, endpoint cone, paths, and fanout. Add internal worker
milestones as those workers land. Do not infer Yosys execution, artifact
ingestion, Rust session construction, layout, or IndexedDB lookup time from a
broader UI measurement.
