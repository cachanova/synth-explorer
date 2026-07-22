# Architecture

Synth Explorer is a static, browser-local RTL exploration application. Vercel
delivers files from `web/dist/`. The default Yosys synthesis path, analysis,
caching, and graph interaction require no application server. An explicitly
selected optional path can call Vivado through a loopback-only service running
on the user's computer.

## Runtime flow

1. For Yosys, React waits for 250 ms without an input change, then validates the files,
   top, synthesis platform, and visible platform-specific flags. A newer edit cancels
   obsolete work instead of allowing a stale result to land.
2. A SHA-256 key covers the cache schema, pinned frontend/tool versions,
   validated input, and exact source text.
3. IndexedDB returns a matching local artifact. On a miss, an exact generic-gates
   default/example input may load a content-addressed precomputed artifact from
   the Vercel edge; otherwise a Web Lock coordinates one synthesis run across
   tabs.
4. For VHDL-2008, `ghdl.worker.ts` analyzes files in workspace order,
   elaborates the explicit top entity, and emits generic Verilog. VHDL location
   comments become `` `line `` directives before the next stage. Verilog and
   SystemVerilog skip this frontend stage.
5. `yosys.worker.ts` runs project-built Yosys 0.67 in WASI and emits normalized
   and source-provenance JSON netlists.
6. `analysis.worker.ts` loads those netlists into the canonical Rust
   `analysis-core` compiled to WebAssembly.
7. UI queries for endpoints, paths, timing estimates, cones, fanout, netlist
   projections, source maps, source selections, and node details are worker
   messages. Results are bounded before crossing the worker boundary.
8. SchemWeave lays out bounded subgraphs in a dedicated Rust/WebAssembly worker.

Local Vivado is a manual branch after validation. The user starts
`synth-explorer-vivado-bridge` with an exact-origin allowlist, authorizes
browser loopback access, and selects a family plus speed grade from the
installation's authoritative part catalog. The browser sends the RTL, explicit
top, concrete resolved part, and validated `synth_design` arguments to
`http://127.0.0.1:32123`. The bridge invokes Vivado directly with argv and a
generated Tcl file, runs `report_timing -max_paths 1 -delay_type max`, then
returns structural Verilog plus the bounded timing report. The existing Yosys
worker normalizes that netlist and the existing analysis worker owns every
downstream structural query. No hosted service sees the RTL or result.

There is no hosted HTTP API, application server, remote design identifier,
account, or shared design store. The optional HTTP protocol exists only on the
user's loopback interface. The twelve-character design ID shown in the UI is
only a display prefix of the full local cache digest.

## Canonical implementations

- `web/src/lib/yosysScript.ts` is the only Yosys script builder, including the
  Vivado-netlist normalization script.
- `vivado-bridge/` is the only runtime Vivado executor and Tcl builder.
- `web/src/lib/vhdl.ts` is the only GHDL-to-Yosys source-location rewrite.
- `analysis-core/` is the only netlist/graph and source-selection analysis
  implementation.
- `layout-wasm/` pins and exposes SchemWeave as the only schematic layout
  implementation.
- IndexedDB stores the current editor workspace and is the only mutable
  completed-design cache. Those records live in separate databases and have
  separate reset controls. Immutable precomputed example artifacts only seed
  that same synthesis path after exact key and contract validation.

No remote fallback, shadow Yosys runner, disabled backend, or hosted Vivado path
exists in production. Local Vivado is selected explicitly and never replaces a
failed browser Yosys run.

## Cache and resource bounds

The cache is scoped to the application origin and browser profile. Records are
validated against the requested input, schema, producer version, and shape.
Corrupt or expired records are deleted. Retention is bounded to 24 entries,
128 MiB estimated total size, a 128 MiB per-entry ceiling, and 30 days since
last access. Browser storage eviction, private browsing, clearing site data, or
changing devices removes or hides entries.

The default design and both language variants of every bundled example have a
precomputed generic-gates artifact. Their filenames are the full synthesis
cache keys and Vercel caches them immutably. The bundled key manifest prevents
arbitrary user inputs from issuing speculative artifact requests. A missing,
stale, or malformed artifact falls through to browser-local synthesis.

The editor workspace is a single versioned record containing only editable
synthesis inputs. Derived analysis state is not restored across page loads.

GHDL has a 30-second wall timeout. Yosys has a 60-second wall timeout and
128 MiB combined netlist-output limit. The Vivado bridge accepts at most 4 MiB
of source, returns at most 64 MiB of structural Verilog, caps timing reports at
256 KiB, caps logs at 64 KiB, allows one run at a time, and has a five-minute
wall timeout.
The application runs only one requested synthesis at a time. A completed
worker is reused so its streamed, compiled Yosys module and unpacked resources
stay warm; cancellation or a worker failure terminates it and immediately
starts a clean replacement. Each run still creates a new WebAssembly instance
and WASI filesystem. Analysis and layout remain in separate workers so
expensive work does not block the React thread. The layout worker owns
SchemWeave graph preparation, layered placement, orthogonal routing, and result
adaptation; the React thread sends
only compact, bounded layout fields and reattaches its resident graph metadata
to the compact geometry response. The graph surface stays mounted across tabs,
so it starts that reusable worker once at mount and preloads the SchemWeave WASM
module. This lets fetch and compilation overlap the editor's initial idle/debounce
window and finish before the first design layout request. A failed speculative
load is discarded so the first real request retries, and no design-sized graph
is laid out speculatively. Register D, Q, clock, reset, set, and enable pins use
the same fixed offsets in the renderer and layout ABI; non-register pins use a
stable sorted order, and fanout edges sharing a source pin carry one electrical
net identity for shared routing. In the browser, the memoized edge
layer groups routes into at most 16 SVG paths by control, bus, highlight, and
relevance style. Arrowheads are equivalent batched triangle geometry, while bus
labels stay individually positioned. A small spatial index resolves the exact
connection under the pointer and renders one delegated net tooltip, avoiding a
path, title, and accessibility-tree symbol for every edge. The edge layer
instead exposes one concise accessible connection summary; keyboard users
inspect connectivity through the existing node buttons and fanin/fanout
actions. Node click, expansion, focus, keyboard, and pointer interactions are
delegated at the SVG boundary. Every node keeps one stable, memoized,
accessible outline shell, while rich labels, pins, controls, and grouped-symbol
decoration render in a separate overlay only for nodes intersecting the
viewport plus overscan. Compact overlays omit full-only content instead of
mounting it hidden. Selected and focused nodes always receive full detail, and
one delegated node tooltip replaces per-node SVG title children. A second
small overlay owns the transient pointer/focus listeners and renders pin labels
only for the unique selected, hovered, or focused nodes, so handler and hook
state do not grow with graph size. The viewport detail level retains
hysteresis and idle restoration; pan and zoom frames remain outside React
state, and visible overlay IDs refresh only after the gesture is idle. The GHDL
worker follows the same reuse policy while creating a fresh
Ada/WebAssembly instance per run.

## Timing

Yosys/browser timing values are structural, pre-place-and-route estimates. They
are not timing closure and contain no placed or routed interconnect.
Coefficients may be recalibrated locally against external tools.

Vivado designs do not use the browser timing model in the Overview or Paths
tabs. The Overview timing card comes from Vivado's own post-synthesis
`report_timing -max_paths 1 -delay_type max` result returned by the local
connector. It is still pre-place-and-route unless the local Vivado flow is later
extended with implementation constraints and placement/routing steps. Vivado is
a runtime dependency only when the user explicitly selects the optional local
tool.

## Deployment

`vercel.json` builds `web/`, publishes `web/dist/`, rewrites SPA routes to
`index.html`, serves WebAssembly with the correct content type, and applies
immutable caching to versioned assets. CI verifies Rust, regenerates and checks
the analysis and layout WASM packages, verifies pinned Yosys and GHDL hashes
and precomputed example contracts, builds the static app, and runs browser-local synthesis E2Es that
assert zero `/api` traffic.
Vercel Web Analytics and Speed Insights collect page-level usage and browser
performance metrics; they are not part of the synthesis path and receive no RTL
or synthesized netlist content.
