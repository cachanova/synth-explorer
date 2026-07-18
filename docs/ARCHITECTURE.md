# Architecture

Synth Explorer is a static, browser-local RTL exploration application. Vercel
delivers files from `web/dist/`; after those files are loaded, synthesis,
analysis, caching, and graph interaction require no server requests.

## Runtime flow

1. React validates the files, top, synthesis mode, and visible mode-specific
   flags.
2. A SHA-256 key covers the cache schema, pinned Yosys version, validated input,
   and exact source text.
3. IndexedDB returns a matching local artifact or a Web Lock coordinates a
   single Yosys run across tabs.
4. `yosys.worker.ts` runs project-built Yosys 0.67 in WASI and emits normalized
   and source-provenance JSON netlists.
5. `analysis.worker.ts` loads those netlists into the canonical Rust
   `analysis-core` compiled to WebAssembly.
6. UI queries for endpoints, paths, timing estimates, cones, fanout, netlist
   projections, source maps, and node details are worker messages.
7. `exploration.worker.ts` performs the one browser source-selection projection
   against the Rust-produced exploration snapshot; elkjs lays out bounded
   subgraphs in its own worker.

There is no HTTP API, application server, remote design identifier, account,
or shared design store. The twelve-character design ID shown in the UI is only
a display prefix of the full local cache digest.

## Canonical implementations

- `web/src/lib/yosysScript.ts` is the only synthesis-script builder. Both the
  browser worker and local calibration CLI use it.
- `analysis-core/` is the only netlist/graph analysis implementation.
- `web/src/lib/exploration.ts` is the only source-selection projection
  implementation and runs in `exploration.worker.ts`.
- IndexedDB is the only completed-design cache.

No remote fallback, shadow Yosys runner, disabled backend, or hosted Vivado path
exists in production.

## Cache and resource bounds

The cache is scoped to the application origin and browser profile. Records are
validated against the requested input, schema, producer version, and shape.
Corrupt or expired records are deleted. Retention is bounded to 24 entries,
128 MiB estimated total size, a 128 MiB per-entry ceiling, and 30 days since
last access. Browser storage eviction, private browsing, clearing site data, or
changing devices removes or hides entries.

Yosys has a 60-second wall timeout and 128 MiB combined netlist-output limit.
The application runs only one requested synthesis at a time. Terminating the
Yosys worker discards its WASI filesystem. Analysis and layout remain in
separate workers so expensive work does not block the React thread.

## Timing model

Timing values are structural, pre-place-and-route estimates. They are not
timing closure and contain no placed or routed interconnect. Coefficients may be
recalibrated locally against external tools, including a separately licensed
Vivado installation, but vendor tools and reports are not runtime dependencies.

## Deployment

`vercel.json` builds `web/`, publishes `web/dist/`, rewrites SPA routes to
`index.html`, serves WebAssembly with the correct content type, and applies
immutable caching to versioned assets. CI verifies Rust, regenerates and checks
the analysis WASM package, verifies pinned Yosys hashes, builds the static app,
and runs browser-local synthesis E2Es that assert zero `/api` traffic.
