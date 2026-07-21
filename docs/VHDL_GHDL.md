# VHDL Runtime

Synth Explorer supports VHDL-2008 in the default browser Yosys engine and in
the optional local Vivado engine. The hosted Synth Explorer site never receives
RTL. The Vivado engine sends source only to the user-started loopback connector
at `127.0.0.1`.

## Browser Yosys Flow

```text
VHDL-2008 source files
  -> ghdl.worker.ts
  -> generic Verilog with VHDL location comments
  -> source-location rewrite in web/src/lib/vhdl.ts
  -> yosys.worker.ts
  -> source and mapped JSON netlists
  -> analysis.worker.ts
```

In this engine, GHDL is a frontend stage only. Every generic-gate, LUT4, LUT6,
iCE40, ECP5, and Xilinx mapping mode runs through the canonical Yosys script
builder.

## Local Vivado Flow

```text
VHDL-2008 source files
  -> ghdl.worker.ts and yosys.worker.ts source-stage netlist
  -> synth-explorer-vivado-bridge on 127.0.0.1
  -> Vivado read_vhdl -vhdl2008 and synth_design
  -> Vivado structural Verilog
  -> yosys.worker.ts Vivado normalizer
  -> analysis.worker.ts
```

For the Vivado engine, the browser still uses GHDL and Yosys to build the
source-stage netlist used for provenance. The original source files are also
sent to the explicitly started loopback bridge. The bridge writes those files to
a temporary directory, invokes Vivado with argv plus a generated Tcl script, and
returns structural Verilog. The browser then normalizes that Vivado netlist with
Yosys and uses the same Rust analysis worker for downstream queries.

## Runtime Contract

- VHDL workspaces require an explicit top entity.
- Files are analyzed in workspace order, so packages must precede dependent
  entities and architectures.
- A workspace is either VHDL or Verilog/SystemVerilog. Mixed-language
  elaboration is not supported.
- For the browser Yosys engine, syntax and semantic diagnostics are returned
  from GHDL before Yosys runs.
- For the local Vivado engine, Vivado also receives the original VHDL files and
  may report tool-specific diagnostics from the bridge.
- GHDL source-location comments are converted to Verilog `` `line ``
  directives before Yosys receives the generated Verilog.
- Yosys emits `src` attributes that point to the original VHDL file and line.
  Generated-Verilog columns should not be interpreted as VHDL columns.
- Browser Yosys cache identity includes the GHDL artifact version for VHDL
  records. Local Vivado cache identity includes the Vivado bridge identity,
  selected part metadata, the Yosys normalizer version, and the GHDL artifact
  version for VHDL records.

## Implementation Owners

- `web/src/workers/ghdl.worker.ts` hosts the GHDL module, standard-library
  virtual filesystem, diagnostics, and synthesis API.
- `web/src/lib/vhdl.ts` owns the source-location rewrite.
- `web/src/lib/localEngine.ts` invokes GHDL only for validated VHDL workspaces,
  chooses the Yosys or Vivado synthesis branch, and returns to the shared cache
  and analysis path.
- `vivado-bridge/` owns the local Vivado executor and generated Tcl script for
  the optional engine.
- `tools/ghdl-wasm/` owns the reproducible GHDL WebAssembly build and smoke
  fixtures.
- `web/public/ghdl/` stores the pinned runtime artifacts and checksums used by
  the static app.
