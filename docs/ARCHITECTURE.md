# Synth Explorer — Architecture

Compiler Explorer for RTL. Paste Verilog/SystemVerilog, synthesize with Yosys
(generic gates, LUT4/LUT6, or FPGA target flows), then **explore the synthesized
logic** — timing-path endpoints, longest logical paths, fanin/fanout cones,
high-fanout nets, and source cross-probing — instead of staring at an unreadable
full schematic.

## Product Thesis

Not a prettier full-schematic renderer. A **graph-first circuit debugger**:

- Discover all meaningful endpoints: registers, top-level outputs, memory/
  blackbox inputs.
- Select a register/signal → see only the relevant fanin or fanout cone.
- Rank paths by logical depth (cell levels / LUT levels).
- Cross-link graph nodes back to RTL source via yosys `src` attributes.
- Inspect how different code or synthesis modes affect depth and fanout.

Full schematic view exists but is an option, capped by size — not the main flow.

**Caveat shown in the UI:** all numbers are structural/logical estimates from the
synthesized netlist. This is not post-place-and-route timing. Real timing closure
needs nextpnr/OpenSTA/Vivado/Quartus reports (future: import + overlay them).

## Stack Decision

- **Analysis core: Rust.** The `analysis-core` crate owns netlist parsing,
  graph construction, provenance recovery, grouping, BFS cones, longest-path
  DP, and SCC detection. The server consumes this crate rather than carrying a
  second implementation.
- **Backend: Rust** (axum + tokio + serde). It owns the current HTTP API,
  native synthesis processes, bounds, and retention while the browser-local
  migration is in progress.
- **Frontend: React + TypeScript + Vite.** CodeMirror 6 for editing,
  **elkjs** (layered layout, same engine netlistsvg uses) in a Web Worker for
  cone layout, custom SVG rendering with pan/zoom.
- **Synthesis: Yosys plus optional Vivado.** Yosys 0.67 produces the canonical
  JSON netlist. The Vivado path runs `synth_design`, exports structural
  Verilog, then uses a read-only Yosys pass to normalize that netlist into the
  same parser contract. Deployments only advertise Vivado when `VIVADO_BIN`
  passes startup preflight and returns a non-empty installed part catalog.
- No database. Designs are keyed by a content hash of (sources, tool, mode,
  target, args). A 512 MiB, 30-minute in-memory FIFO cache serves active
  exploration, backed by an 8 GiB local file store with a 4-hour sliding TTL
  and least-recently-used eviction; one entry is capped at 512 MiB. Cold hits
  rebuild the graph and analysis state from the stored netlists without running
  synthesis again. Cold rebuilds are serialized to bound transient memory on
  the single host. Writes use an atomic rename, and incompatible, corrupt,
  expired, or evicted entries are discarded. The file store survives
  application restarts and deployments but is local to one host; horizontal
  replicas would require shared storage or request affinity. It is a
  single-writer store for the deployment's one application process. Disk-write
  failures degrade to hot-cache-only retention instead of failing synthesis.
- Hot-cache hits share a read lock; only expired-entry cleanup and insertion
  take the write lock. Retained size is derived structurally so new owned fields
  cannot bypass cache accounting silently.

## Synthesis Modes

| Mode | Script core | Produces |
| --- | --- | --- |
| `rtl` | `prep -top <top>; flatten` | word-level RTL cells (`$add`, `$mux`, `$dff`…) |
| `gates` | `synth -top <top> -flatten` | generic gates (`$_AND_`, `$_NAND_`, `$_SDFF_PP0_`…) |
| `lut4` | `synth -top <top> -flatten -lut 4` | `$lut` cells (WIDTH≤4) + FF cells |
| `lut6` | `synth -top <top> -flatten -lut 6` | `$lut` cells (WIDTH≤6) + FF cells |
| `ice40` | `synth_ice40 -top <top> -flatten` | `SB_LUT4`, `SB_CARRY`, `SB_DFF*` |
| `ecp5` | `synth_ecp5 -top <top> -flatten` | `LUT4`, `CCU2C`, `TRELLIS_FF` |
| `xilinx` | `synth_xilinx -top <top> -flatten` (split at `fine` to soft-map <= 8-bit `$alu`/`$lcu` results to LUTs instead of carry chains) | `LUT1-6`, `CARRY4`, `FD?E` |

Vivado is a separate synthesis tool, not a mode. It uses `tool=vivado` and the
API-compatible `mode=gates` value while the webpage hides the Mode control. Any
part returned by the deployment's startup `get_parts` catalog can be selected;
the server checks that allowlist before scheduling `synth_design`. Structural
Verilog normalization produces device-appropriate primitives such as LUTs,
carry chains, and flip-flops.

- Sources are written to a temp dir; the script is built programmatically
  (never shell-interpolated) as `read_verilog -sv <files>; <mode script>;
  write_json <out>`.
- `-top` omitted → `-auto-top`. User-supplied **extra args** are tokenized and
  each token must match `^[A-Za-z0-9_+=.,:-]+$` (rejects `;`, quotes, paths out).
  They are appended to the mode's synth command.
- Yosys enforces a 60 s wall timeout. Vivado gets 5 minutes and a 16 GiB
  address-space cap; its normalization pass gets 60 s. Both paths enforce log
  and JSON size caps, process-group cleanup, and temp-dir cleanup.
- `src` attributes survive on RTL cells and FFs; ABC-generated LUTs/gates lose
  them — source cross-probe is best-effort by design and the UI says so.

## Graph Model (bit-level, index-based)

Parsed from yosys JSON (`modules.<top>` after flatten):

- **Net** = yosys bit index (u32). `netnames` gives human names per bit
  (`sum[3]`), preferring non-`hide_name` entries.
- **Node** (u32 index into arena) = one of:
  - `Cell { type, name, params, src, seq: bool }`
  - `PortBit { port, bit, dir }` (top-level I/O, one node per bit)
  - `Const` (0/1/x driver)
- **Edges** are derived from cell connections using `port_directions`
  (fallback heuristic: `Y/Q/O` output, else input): driver-node → sink-node,
  labeled with (net bit, sink port, driver port).
- **Sequential cell classification** by type: `$dff*/$sdff*/$adff*/$aldff*/
  $dffe*/$ff/$_DFF*/$_SDFF*/$_ALDFF*/$_FF_`, `$mem*`, `SB_DFF*`, `TRELLIS_FF`,
  `FD??`/`FDRE/FDSE/FDCE/FDPE`, plus any cell whose type is not a known
  combinational primitive and not a module in the design (**blackbox** —
  treated as sequential-like boundary: its inputs are path endpoints, its
  outputs are path startpoints).
- **Clock/reset/enable identification:** FF cell control pins (`CLK/C/EN/E/
  R/S/ARST/SRST/CLR/PRE/CE`) are tagged so cones can hide them by default and
  the fanout view can label control nets.

### Timing-path semantics

- **Startpoints:** top-level input bits, FF `Q` outputs, blackbox/memory outputs.
- **Endpoints:** FF `D` inputs (data pin; control pins reported separately),
  top-level output bits, blackbox/memory inputs.
- **Depth metric:** longest weighted structural depth into the endpoint. Data-
  path logic and carry primitives count as one level; recognized infrastructure
  buffers count as zero. This metric is intentionally separate from delay.
- **Estimated timing:** a second fanout-aware DP combines per-category cell
  coefficients (LUT, carry, wide mux, generic cell), launch/setup terms, and
  estimated net delay. Xilinx presets are calibrated against Vivado post-synth
  timing; other presets and manual overrides remain estimates, not timing
  closure. Retuning reuses the model-independent combinational-loop set found
  during initial analysis.
- **Algorithm:** restrict to combinational subgraph; Tarjan SCC to detect
  combinational loops (nodes in loops are excluded and reported as warnings);
  DP over topological order computes depth + argmax predecessor per node —
  O(V+E). Path reconstruction walks predecessors. Top-K endpoints by depth,
  each with its critical path (node list with names/types/src).
- **Fanin/fanout cones:** BFS from the selected node, stopping at startpoint/
  endpoint boundaries, with depth and node-count caps (`truncated` flag).
- **Fanout ranking:** per driver (FF Q, input bit, cell output), count sink
  pins and distinct endpoint cells; top-N descending, control nets labeled.

## API (see docs/API.md for the exact contract)

- `POST /api/synthesize` → `{design_id, top, tool, mode, target?, stats, warnings, log}`
- `GET  /api/design/:id/endpoints` — registers (grouped, with width/clock/src/
  depth), outputs, inputs
- `GET  /api/design/:id/paths?limit&to&sort&profile&speed_grade&model` — ranked
  longest paths w/ full node list and optional retuned per-path delay
- `POST /api/design/:id/timing` — retune the cached design's estimated critical
  delay and category breakdown without re-synthesizing
- `GET  /api/design/:id/cone?node&dir&max_depth&max_nodes` — renderable subgraph
- `GET  /api/design/:id/fanout?limit` — fanout ranking
- `GET  /api/design/:id/netlist?max_nodes` — full graph (capped) for the
  optional schematic view
- `GET  /api/design/:id/exploration` — complete prepared graph and provenance
  indexes loaded once by the browser's source-selection worker
- `GET  /api/examples` — bundled example designs
- Server serves `web/dist` statically; SPA fallback.

## Frontend

Compiler-Explorer-style split view, dark theme:

- **Left pane:** CodeMirror 6 editor (Verilog mode), examples dropdown, top
  module + mode + extra-args controls, Synthesize (Ctrl+Enter). Error/log strip.
- **Right pane tabs:**
  - **Overview** — cell-type histogram, reg/port counts, warnings, yosys log,
    and an estimated-timing panel with profiles, speed grades, and coefficient
    overrides. Technology-neutral gates/LUT modes keep the selector visible but
    withhold absolute timing until the user chooses a real process or FPGA.
  - **Schematic** — the cone viewer: elkjs layered layout in a worker, SVG nodes
    (cells with type + name, ports, consts), pan/zoom, click node → expand
    cone / show src; toggles for constants and clock/reset/enable; direction
    switch (fanin/fanout). Schematic opens on the capped full diagram with Focus
    enabled by default; the first source or endpoint selection re-lays out only
    its relevant subgraph. Turning Focus off restores the full layout, and later
    selections update only its relevance highlights. Escape clears a source
    selection.
  - **Endpoints** — fuzzy-searchable registers/outputs; click → Schematic tab cone.
  - **Paths** — ranked longest paths; click → path highlighted in Schematic tab;
    per-node src hop back to editor.
  - **Fanout** — ranked high-fanout drivers; control nets badged; click → fanout
    cone.
- **Source cross-probe:** node src (`file.sv:12.16-12.21`) → editor highlight;
  editor cursor line → a dedicated TypeScript worker queries the exploration
  snapshot locally and returns the focused subgraph/highlights without another
  server request. The worker lazily fetches and parses the snapshot itself when
  the schematic becomes active; bounded, serialized snapshot construction runs
  off the server's async executor.
- Store consumers subscribe through field selectors, so editor keystrokes do
  not invalidate analysis tabs or the schematic. Superseded ELK results are
  discarded by sequence id while the worker stays warm; the worker is replaced
  only after an error or real layout timeout.

## Example RTL (`examples/`)

The example picker contains parameterized, reusable RTL modules rather than
analysis-specific fixtures: muxed registers; case-, loop-, and carry-based
priority encoders; an N-input adder chain; a barrel shifter; a round-robin
arbiter; fixed-latency, SRL, and elastic pipelines; an inferred FIFO; an async
FIFO IP wrapper; and a request/response handshake controller.

The modules intentionally cover portable RTL and common FPGA inference idioms.
The three priority encoders use the same lowest-numbered-request convention so
their synthesized implementations can be compared directly. The inferred FIFO
shows a source-defined memory and pointers, while the async FIFO wrapper shows a
realistic blackbox boundary around vendor-generated clock-domain-crossing IP.

## Testing

- **Rust:** `analysis-core` unit and integration tests cover parser, graph, and
  analysis semantics over committed fixture JSONs. Server integration tests
  run Yosys on `examples/` and assert semantic facts such as `adder_chain`
  depth exceeding `reg_mux` depth and blackbox boundaries remaining explicit.
- **Frontend:** `tsc --noEmit`, `vite build`, vitest on pure logic (API client,
  graph transforms, and source-selection traversal).
- **E2E:** drive Chrome against the built stack — synthesize each example, walk
  endpoints → cone → paths → fanout → browser-worker source probe. Contract
  tests feed real Rust/Yosys exploration snapshots through the canonical
  TypeScript selector for procedural narrowing, registered-output expansion,
  and assignment direction.

## Future (explicitly out of scope now)

Vivado/nextpnr/OpenSTA timing-report import + overlay; hierarchy-preserving
view; CDC structural detection; giant-mux/wide-comparator detectors; permalinks;
export cone as SVG/PNG; WASM yosys for a serverless mode.
