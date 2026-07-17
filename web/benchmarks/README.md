# Browser migration benchmark

This harness compares the pinned main backend with the static browser-local
candidate by driving the same production UI flow in Chromium. It measures cold
and warm browser states at 0 ms and 150 ms artificial request latency.

## Prepare the builds

Build both frontends with their locked dependencies. Start pinned main with its
native server and an empty design store:

```bash
BIND_ADDR=127.0.0.1:8787 \
STATIC_DIR=/absolute/path/to/main/web/dist \
DESIGN_STORE_DIR=/tmp/synth-explorer-control-designs \
cargo run --manifest-path /absolute/path/to/main/server/Cargo.toml --release
```

Serve the candidate as static files only:

```bash
cd /absolute/path/to/candidate/web
npm run preview -- --host 127.0.0.1 --port 8788
```

Do not run unrelated CPU- or memory-heavy work during the benchmark.

## Run

```bash
npm run benchmark:migration -- \
  --control http://127.0.0.1:8787 \
  --control-revision 0123456789abcdef0123456789abcdef01234567 \
  --candidate http://127.0.0.1:8788 \
  --candidate-revision 89abcdef0123456789abcdef0123456789abcdef \
  --trials 5 \
  --output /tmp/browser-migration-result.json
```

Each trial creates a fresh browser context for its cold pass and reloads the
same context for its warm pass. The result includes raw samples and median,
p95, min, and max duration, HTTP traffic, failed requests, and renderer heap.
The phases cover page readiness, first synthesis-to-Overview, an identical
same-page synthesis cache hit, endpoints, endpoint cone rendering, paths, and
fanout. Full-flow comparisons exclude the repeat synthesis phase; report that
phase separately as the user-visible cache-hit latency.
