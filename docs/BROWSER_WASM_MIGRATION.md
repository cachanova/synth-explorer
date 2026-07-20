# Browser-local migration record

## Decision and outcome

Synth Explorer production is a static application. Public Yosys synthesis,
Rust netlist/graph analysis, source exploration, and completed-design retention
all run in the browser. Production has no HTTP application server, hosted
Vivado, database, volume, or server-side design cache.

Vivado is retained only as an optional licensed dependency for manual local
calibration. Calibration imports the canonical production Yosys script builder;
it is not a second production synthesis implementation.

## Completed cutovers

1. Pinned main control `3ffd95ef4f6c6fdaa74f715dfb97d68d19313197`
   and added a repeatable browser benchmark harness.
2. Extracted the server analysis into canonical `analysis-core` and proved the
   extraction stayed within benchmark noise.
3. Compiled that Rust core to WebAssembly and replaced all design-analysis HTTP
   routes with a dedicated browser worker.
4. Built project-owned Yosys 0.67 WebAssembly artifacts from exact Yosys, ABC,
   and WASI SDK pins. The worker passes all seven supported synthesis modes.
5. Added a per-browser SHA-256 IndexedDB cache with version/input validation,
   corrupt-record deletion, expiry, size/LRU bounds, Web Lock coordination, and
   a visible clear action.
6. Removed Vivado UI/API support, Axum server code, container/Hetzner deployment
   files, backend workflows, API documentation, and root example duplication.
7. Added a static Vercel configuration and CI that executes real browser-local
   synthesis and asserts zero `/api` requests.

## No-shadow rule

Each runtime responsibility has one implementation:

- production synthesis script: `web/src/lib/yosysScript.ts`;
- synthesis executor: browser Yosys worker;
- structural and source-selection analysis: Rust `analysis-core` in the
  analysis worker;
- completed design cache: browser IndexedDB.

There is no runtime feature flag, remote fallback, alternate endpoint, native
production Yosys, or disabled Vivado/backend implementation.

## Browser cache identity

The full cache digest covers the artifact schema, pinned Yosys producer version,
mode, top, validated synthesis arguments, filenames, and exact RTL bytes.
Timing-model changes do not invalidate synthesis because they do not change the
netlist. The displayed twelve-character design ID is only a prefix; IndexedDB
uses the full digest.

This cache is per origin and per browser profile. It is not per account or
cross-device. The browser may evict it at any time.

## Verification and retirement order

The migration is verified against a production build of pinned main on the same
machine and browser, both without artificial latency and with 150 ms request
latency. Results are recorded in
[`BROWSER_WASM_BENCHMARKS.md`](BROWSER_WASM_BENCHMARKS.md).

Before retiring external infrastructure:

1. all Rust, TypeScript, build, and real-browser checks pass;
2. local main-versus-branch responsiveness results are recorded;
3. the exact candidate is deployed to Vercel and passes synthesis with zero API
   requests;
4. the production domain is verified on that static deployment;
5. only then are old DNS, secrets, volumes, and the exact Hetzner instance
   removed.
