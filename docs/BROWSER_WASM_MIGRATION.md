# Browser-local synthesis and analysis migration

## Decision

Synth Explorer will move public Yosys synthesis, netlist construction, graph
analysis, and design retention into the browser. Rust remains the canonical
analysis implementation and compiles to WebAssembly. Yosys runs in a dedicated
browser worker. The browser stores synthesis artifacts in IndexedDB for the
current browser profile.

The static application will move to Vercel. Vivado, if AMD authorizes its use,
will remain on Hetzner behind `api.synthexplorer.dev`. The browser will call that
origin directly because a Vivado run can exceed Vercel's proxy timeout. The
Vivado service will return one normalized artifact and will not retain the
submitted design for exploration.

Before the production cutover, the project owner will record whether AMD has
authorized the public hosted Vivado use in writing. An authorization keeps the
narrow Vivado service. Missing, ambiguous, or narrower authorization counts as
no authorization and removes Vivado, the Rust HTTP server, the Hetzner
deployment, its secrets, and its persistent volume. The repository will not
keep a disabled Vivado implementation.

## End state

The browser owns:

- Yosys synthesis for `rtl`, `gates`, `lut4`, `lut6`, `ice40`, `ecp5`, and
  `xilinx` modes;
- netlist parsing, graph construction, provenance recovery, grouping, timing
  estimates, endpoints, paths, cones, fanout, source probes, and projections;
- one active analysis session in a Rust WebAssembly worker;
- a per-origin IndexedDB cache of synthesis artifacts;
- examples and build metadata shipped as static assets.

Vercel owns static delivery, preview deployments, TLS, and the production
domain. The deployment uses no Vercel Functions.

If Vivado remains, Hetzner owns:

- owner authentication and the installed-part catalog;
- Vivado synthesis and `report_timing`;
- native Yosys normalization of Vivado structural Verilog;
- process limits, concurrency control, cleanup, and service health.

The retained service will expose a versioned Vivado artifact endpoint and
`/healthz`. It will not expose public Yosys synthesis or `/api/design/:id/*`
exploration routes.

## External constraints

- [Vercel limits](https://vercel.com/docs/limits) cap proxied external requests
  at 120 seconds. The current five-minute Vivado allowance therefore requires
  a direct browser request to the Hetzner API origin.
- The [YoWASP Yosys repository](https://github.com/YoWASP/yosys) was archived
  on March 11, 2026 and describes its packages as unofficial. Use it only as a
  build seed. Before browser Yosys ships, create a project-owned fork, pin the
  Yosys and ABC sources, produce reproducible artifacts, record licenses and an
  SBOM, and own security and browser-compatibility updates.

## One implementation at each stage

Production code will contain one implementation for each behavior.

- The server will consume the extracted Rust core as soon as the files move.
  The old server-local modules will disappear in the same change.
- The Rust WebAssembly worker will replace the TypeScript traversal currently
  implemented in `web/src/lib/exploration.ts`. The TypeScript traversal will
  disappear in the cutover change.
- Browser analysis will replace the server exploration routes. The routes,
  graph cache, disk store, and reconstruction code will disappear in that
  change.
- Browser Yosys will replace public server Yosys. The public server path will
  disappear in that change. Native Yosys may remain only inside the Vivado
  normalizer.
- IndexedDB will become the only completed-design cache. The backend will keep
  no completed-design cache. A short-lived Vivado concurrency guard does not
  retain completed work.

The migration will not add a runtime flag, fallback transport, alternate
endpoint, or local-versus-remote Yosys selector. Intermediate commits may move
one responsibility at a time, but each commit will run one live path for that
responsibility.

## Artifact and browser cache

The synthesis artifact will contain the validated synthesis request, producer
version, final normalized netlist, source-provenance netlist, bounded log, and
tool-specific metadata. Rust will rebuild its in-memory graph and indexes from
that artifact. The cache will not serialize Rust heap state.

The cache key will use the full SHA-256 digest of:

1. artifact schema version and producer version;
2. synthesis tool, mode, target, top, and synthesis-affecting arguments;
3. validated filenames and exact source bytes.

The twelve-character design id can remain a display identifier derived from
the full digest. IndexedDB will use the full digest. A timing-model retune will
not change the synthesis key because it does not change the netlist.

The cache will use a byte budget, a per-entry limit, sliding expiry, and LRU
eviction. It will reject artifacts with the wrong digest, schema, or producer
version. A Web Lock keyed by the digest will coordinate tabs: a tab will check
IndexedDB, acquire the lock on a miss, check again, and then synthesize. Browser
eviction, private browsing, clearing site data, or using another browser or
device can remove or hide the cache. No account-level or cross-device retention
will exist.

## Workers and resource bounds

Yosys and Rust analysis will use separate workers. Yosys can block its worker
without blocking graph queries or the React thread. The application will keep
one running synthesis and one active analysis session.

The Yosys worker will preserve the current input validation, 60-second timeout,
log bound, output bound, and abstract-memory retry. Cancellation or timeout will
terminate the worker and discard its virtual filesystem. The migration cannot
ship as the default path until tests show that a runaway or out-of-memory
synthesis leaves the page usable after worker replacement.

The analysis worker will retain the graph and indexes. It will return the same
bounded response shapes used by the current UI. React will receive endpoints,
paths, and capped subgraphs rather than the full graph. A new synthesis will
dispose the previous analysis session before the browser ingests the new
artifact, which bounds peak retained graph memory.

## Migration stages

### 1. Pin the control and add the benchmark harness

Record the feature branch's base commit. Build that commit in a read-only
control worktree and build the candidate in this worktree. Run both builds on
the same machine with the same Chrome version. Run them in sequence so one does
not steal CPU or memory from the other.

The initial base for this branch is `3ffd95e`, the main commit that moved source
selection into a browser worker. The harness will record full commit hashes in
each result so later main updates cannot change the control.

### 2. Extract the canonical Rust core

Create a root Cargo workspace with an analysis-core crate, a WebAssembly wrapper
crate, and the server crate. Move netlist, graph, analysis, grouping,
source-provenance, delay-model, and shared response types out of `server/`.
Move the server's design-construction function into the core. Update the server
to consume the core in the same commit.

Run the existing Rust tests against the extracted crate. This stage must leave
API output and performance within benchmark noise.

### 3. Move exploration into Rust WebAssembly

Add a dedicated analysis worker that owns one Rust core session. Move source
selection from TypeScript into the core and delete the TypeScript traversal.
Change synthesis to deliver one versioned artifact to the worker. Route
endpoints, timing retunes, paths, cones, line selection, fanout, netlist views,
source maps, and node lookup through worker messages.

Delete `/api/design/:id/*`, `DesignCache`, `DesignStore`, the design volume, and
server graph construction in the same cutover. Both Yosys and Vivado synthesis
will return artifacts without retaining completed designs.

### 4. Move Yosys into the browser

Move synthesis request validation and Yosys script construction into portable
code. Run the script through a pinned browser Yosys package in a synthesis
worker. Package the technology libraries with the static build and load them on
the first Yosys request.

The deployed native tool is Yosys 0.67. The browser cutover requires a pinned
0.67 WebAssembly build with ABC and every supported target flow. The published
YoWASP package must not silently substitute an older compiler. Build and pin
the 0.67 artifact through the project-owned packaging fork before continuing;
an archived upstream package is not a production dependency.

Delete public server Yosys handling after the worker passes the parity and
resource tests. Keep native Yosys only if the Vivado normalizer still needs it.

### 5. Add IndexedDB retention

Write a verified artifact after synthesis and load it before starting Yosys or
Vivado. Rebuild the Rust session from a cache hit. Add cross-tab locking,
bounded LRU eviction, corrupt-record deletion, version invalidation, and a
visible clear-local-cache action.

Remove the remaining backend persistence configuration, deployment volume,
retention documentation, and `unknown design` behavior.

### 6. Move the static application to Vercel

GitHub Actions will build Rust WebAssembly, package Yosys, build Vite, run the
browser synthesis tests, and deploy the verified static output. Pull requests
will receive Vercel previews. Production promotion will use the tested commit,
not a rebuilt moving branch.

Configure the SPA rewrite, correct WebAssembly content types, immutable caching
for hashed assets, and a short cache lifetime for `index.html` and build
metadata. A scheduled Playwright job will load the production URL and complete
a browser-local synthesis.

If Vivado remains, point `api.synthexplorer.dev` at Hetzner and restrict CORS to
the production frontend origin. Vercel previews will not receive Vivado access.
The frontend will call the API origin directly rather than through a Vercel
rewrite.

### 7. Apply the AMD authorization decision

Record the authorization evidence before production cutover.

- Authorization received: retain and deploy the narrow Vivado service, then
  remove public Yosys and completed-design retention from its image.
- Authorization absent: delete the Vivado UI, server crate, deploy directory,
  backend workflows, secrets, DNS record, and Hetzner instance. Keep the static
  Vercel deployment and browser-synthesis monitor.

## Benchmark method

Committed summaries are recorded in
[`BROWSER_WASM_BENCHMARKS.md`](BROWSER_WASM_BENCHMARKS.md).

The local control and candidate runs use production builds, the same machine,
the same browser build, and the same fixtures. The harness will test two network
profiles:

- no artificial latency, which compares compute and serialization;
- fixed 150 ms request latency, which exposes the round trips paid by the
  current architecture.

Each profile will include a fresh browser context for cold measurements and a
warmed context for repeat measurements. The harness will report the median,
p95, transferred bytes, request count, and renderer JavaScript heap use exposed
by Chromium. The initial harness records the user-visible boundaries that exist
today:

- page ready;
- synthesis request to Overview ready;
- endpoints and paths ready;
- endpoint selection to cone rendered;
- fanout ready.

As the workers land, explicit performance markers will split out:

- page ready and Yosys asset ready;
- synthesis execution and artifact ingestion;
- analysis-session construction;
- endpoints and paths ready;
- endpoint selection to cone data;
- source selection to focused graph;
- neighbor expansion;
- ELK layout completion;
- IndexedDB hit to analysis ready.

The semantic harness will run every example through every supported Yosys mode
and compare stats, warnings, endpoint groups, ranked paths, fanout, representative
cones, source probes, and node metadata. It will also cover `-noabc`, Xilinx
family and retiming flags, narrow-carry handling, abstract memories,
combinational loops, blackboxes, and source-provenance fixtures.

## Release gates

Each stage must pass its focused unit tests, full Rust and frontend checks, the
semantic comparison, and the local control-versus-candidate benchmark.

The browser-analysis cutover requires zero exploration HTTP requests after the
artifact arrives. The Yosys cutover requires zero API requests for a complete
Yosys synthesize-to-explore flow. The cache cutover requires a repeat synthesis
to skip tool execution and reproduce the same analysis responses.

The final build must recover from synthesis timeout, cancellation, malformed
output, cache corruption, and worker failure without reloading the page. The
largest supported fixtures must stay within the defined worker memory and
artifact limits. The production deploy must pass the browser-local synthesis
monitor before DNS or Hetzner cleanup begins.
