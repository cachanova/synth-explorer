# VHDL support via GHDL WebAssembly

Status: implemented, July 2026.

Synth Explorer supports browser-local VHDL-2008 synthesis using GHDL 5.0.1
followed by the existing pinned Yosys WebAssembly build. RTL remains in the
browser; there is no server synthesis path.

## Architecture decision

The initial investigation considered statically linking libghdl and the
ghdl-yosys plugin into `yosys.wasm`. That route combines two incompatible
runtime environments: AdaWebPack's minimal Ada runtime and Yosys's WASI libc.
It also requires static plugin registration because WASI Preview 1 has no
dynamic linking.

The implemented design uses two sequential workers instead:

```text
VHDL source files
  -> GHDL analysis, elaboration, and synthesis worker
  -> generated generic Verilog
  -> VHDL-location rewrite
  -> existing Yosys worker and synthesis modes
  -> existing Rust analysis worker
```

This keeps the Yosys artifact and synthesis scripts canonical. GHDL is a
frontend stage only; every existing generic and FPGA-target mapping mode still
runs in Yosys.

## Feasibility results

The implementation proved the previously uncertain parts:

- GHDL's synthesis kernel runs under wasm32 when built with AdaWebPack and
  initialized through a generated GNAT binder unit.
- `ieee.numeric_std`, generics, clocked processes, and FSMs synthesize.
- Inferred memories synthesize through the initialized GHDL memory-conversion
  path, and architecture-level `syn_black_box` declarations survive as Yosys
  black-box modules.
- VHDL-2008 analysis works with the bundled, version-matched `std` and `ieee`
  libraries.
- Syntax and semantic errors return readable GHDL diagnostics instead of
  trapping the worker.
- GHDL's emitted source comments can be converted to Verilog `` `line ``
  directives. All cells in the source-stage netlist for the production VHDL
  fixture carry original `.vhdl` locations, and browser source selection can
  resolve those locations into the schematic.
- A production Chromium test exercises the complete static build without API
  requests and verifies both provenance and invalid-input behavior.

The reproducible toolchain and smoke fixtures live in
[`tools/ghdl-wasm/`](../tools/ghdl-wasm/).

## Product integration

- `web/src/workers/ghdl.worker.ts` hosts the Ada module, standard-library
  virtual filesystem, diagnostics, and synthesis API.
- `web/src/lib/vhdl.ts` owns the single source-location rewrite and constructs
  the generated-Verilog input for Yosys.
- `web/src/lib/localEngine.ts` invokes GHDL only for validated VHDL workspaces,
  then follows the existing Yosys/cache/analysis path.
- The synthesis cache identity includes the GHDL artifact version for VHDL
  records.
- File import, saving, examples, and CodeMirror accept `.vhd` and `.vhdl`.
- Every bundled example has a paired VHDL variant available through the
  toolbar language toggle.

## Deliberate boundaries

- VHDL requires an explicit top entity. GHDL's synthesis entry point has no
  equivalent of Yosys `hierarchy -auto-top`.
- VHDL file order is significant. Workspace order is preserved so packages
  can be placed before dependent entities and architectures.
- Mixed VHDL and Verilog workspaces are rejected. Supporting them would
  require a defined cross-language elaboration/linking contract rather than
  merely feeding two parsers.
- VHDL source lines are exact, but columns in Yosys `src` spans describe the
  generated Verilog layout and should not be interpreted as VHDL columns.
- Technology mapping may absorb or create cells without retaining every
  frontend source attribute. The source-stage netlist remains the provenance
  bridge used by analysis.

## Rejected alternatives

- A single GHDL-enabled Yosys module adds substantial toolchain and ABI risk
  without a product benefit over the sequential pipeline.
- Narrow VHDL-to-Verilog translators omit common language features such as
  packages and procedures and weaken source provenance.
- Server-side GHDL contradicts the static, private browser architecture.
