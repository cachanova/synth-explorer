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
- Compare how different code or different synthesis modes change depth/fanout.

Full schematic view exists but is an option, capped by size — not the main flow.

**Caveat shown in the UI:** all numbers are structural/logical estimates from the
synthesized netlist. This is not post-place-and-route timing. Real timing closure
needs nextpnr/OpenSTA/Vivado/Quartus reports (future: import + overlay them).

## Stack Decision

- **Backend: Rust** (axum + tokio + serde). Netlist graphs get large; the
  analysis engine (BFS cones, longest-path DP, SCC detection) wants a fast,
  memory-tight language. Rust was also the user's preference.
- **Frontend: React + TypeScript + Vite.** CodeMirror 6 for editing,
  **elkjs** (layered layout, same engine netlistsvg uses) in a Web Worker for
  cone layout, custom SVG rendering with pan/zoom.
- **Synthesis: Yosys** subprocess (`write_json` netlists). Verified against
  Yosys 0.67. Vivado is future work behind the same `SynthBackend` seam (the
  runner module is the only place that knows how a netlist gets produced).
- No database. Designs live in an in-memory store keyed by a content hash of
  (sources, mode, args); re-synthesizing identical input is a cache hit.

## Synthesis Modes (verified against Yosys 0.67)

| Mode | Script core | Produces |
| --- | --- | --- |
| `rtl` | `prep -top <top>; flatten` | word-level RTL cells (`$add`, `$mux`, `$dff`…) |
| `gates` | `synth -top <top> -flatten` | generic gates (`$_AND_`, `$_NAND_`, `$_SDFF_PP0_`…) |
| `lut4` | `synth -top <top> -flatten -lut 4` | `$lut` cells (WIDTH≤4) + FF cells |
| `lut6` | `synth -top <top> -flatten -lut 6` | `$lut` cells (WIDTH≤6) + FF cells |
| `ice40` | `synth_ice40 -top <top> -flatten` | `SB_LUT4`, `SB_CARRY`, `SB_DFF*` |
| `ecp5` | `synth_ecp5 -top <top> -flatten` | `LUT4`, `CCU2C`, `TRELLIS_FF` |
| `xilinx` | `synth_xilinx -top <top> -flatten` | `LUT1-6`, `CARRY4`, `FD?E` |

- Sources are written to a temp dir; the script is built programmatically
  (never shell-interpolated) as `read_verilog -sv <files>; <mode script>;
  write_json <out>`.
- `-top` omitted → `-auto-top`. User-supplied **extra args** are tokenized and
  each token must match `^[A-Za-z0-9_+=.,:-]+$` (rejects `;`, quotes, paths out).
  They are appended to the mode's synth command.
- Runner enforces: 60 s wall timeout, log + JSON size caps, temp dir cleanup.
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
- **Depth metric:** longest number of combinational cells on any path into the
  endpoint (unit delay per cell; per-type weights are a straightforward future
  extension — the DP already carries a weight function).
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

- `POST /api/synthesize` → `{design_id, top, mode, stats, warnings, log}`
- `GET  /api/design/:id/endpoints` — registers (grouped, with width/clock/src/
  depth), outputs, inputs
- `GET  /api/design/:id/paths?limit&to` — ranked longest paths w/ full node list
- `GET  /api/design/:id/cone?node&dir&max_depth&max_nodes` — renderable subgraph
- `GET  /api/design/:id/fanout?limit` — fanout ranking
- `GET  /api/design/:id/netlist?max_nodes` — full graph (capped) for the
  optional schematic view
- `GET  /api/examples` — bundled example designs
- Server serves `web/dist` statically; SPA fallback.

## Frontend

Compiler-Explorer-style split view, dark theme:

- **Left pane:** CodeMirror 6 editor (Verilog mode), examples dropdown, top
  module + mode + extra-args controls, Synthesize (Ctrl+Enter). Error/log strip.
- **Right pane tabs:**
  - **Overview** — cell-type histogram, reg/port counts, warnings, yosys log.
  - **Endpoints** — fuzzy-searchable registers/outputs; click → Graph tab cone.
  - **Paths** — ranked longest paths; click → path highlighted in Graph tab;
    per-node src hop back to editor.
  - **Fanout** — ranked high-fanout drivers; control nets badged; click → fanout
    cone.
  - **Graph** — the cone viewer: elkjs layered layout in a worker, SVG nodes
    (cells with type + name, ports, consts), pan/zoom, click node → expand
    cone / show src; toggles for constants and clock/reset/enable; direction
    switch (fanin/fanout); Focus on renders only selection-relevant logic,
    while Focus off renders the capped full diagram and highlights that same
    logic; "open full netlist" option with size guard.
  - **Compare** — snapshot current design (A/B); table of depth, worst paths,
    cell counts, fanout deltas between snapshots (different code or modes).
- **Source cross-probe:** node src (`file.sv:12.16-12.21`) → editor highlight;
  editor cursor line → matching nodes listed/highlighted.

## Validation Examples (`examples/`)

Per the spec, each exercising a distinct analysis behavior:

`01_reg_mux.sv` (register behind mux), `02_priority_encoder.sv` (wide priority
chain → deep path), `03_adder_chain.sv` (long carry chain → deepest path),
`04_high_fanout_enable.sv` (one enable fanning to many regs), `05_shared_logic.sv`
(multiple regs sharing a cone), `06_comb_output.sv` (combinational top output),
`07_blackbox.sv` (instantiated blackbox), `08_fsm.sv` (small FSM).

Expected: adder/priority paths rank deepest; enable net tops fanout; selecting a
register shows only its driver cone; blackbox breaks paths at its boundary.

## Testing

- **Rust:** unit tests on parser/graph/analysis over committed fixture JSONs;
  integration tests that run yosys on `examples/` and assert semantic facts
  (e.g. `03_adder_chain` depth > `01_reg_mux` depth; enable fanout ≥ reg count).
- **Frontend:** `tsc --noEmit`, `vite build`, vitest on pure logic (API client,
  graph transforms).
- **E2E:** drive Chrome against the built stack — synthesize each example, walk
  endpoints → cone → paths → fanout → source probe → compare.

## Future (explicitly out of scope now)

Vivado/nextpnr/OpenSTA timing-report import + overlay; per-cell-type delay
weights; hierarchy-preserving view; CDC structural detection; giant-mux/wide-
comparator detectors; permalinks; export cone as SVG/PNG; WASM yosys for a
serverless mode.
