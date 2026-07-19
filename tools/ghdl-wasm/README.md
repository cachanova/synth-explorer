# GHDL WebAssembly build

This directory owns the reproducible GHDL frontend used for browser-local
VHDL synthesis. It builds a small WebAssembly module around GHDL's analysis,
elaboration, and synthesis kernel; the module emits generic Verilog, which the
application passes to its separately pinned Yosys worker.

The production pipeline is:

```text
VHDL-2008
  -> ghdl-synth.wasm
  -> generic Verilog with VHDL location comments
  -> `line source-location rewrite
  -> yosys.wasm
  -> source and mapped JSON netlists
  -> analysis.wasm
```

Keeping GHDL and Yosys in separate workers avoids reconciling AdaWebPack's Ada
runtime with WASI libc and leaves the project-owned Yosys build unchanged.

## Pinned inputs

- GHDL 5.0.1 commit `37ad91899ea3f311423eb91e34f42c0ae1948f79`
- AdaWebPack 24.0.0 release archive, verified by SHA-256
- ghdl-browser commit `e98e5a6c6fd6c48a789705ae9900c6b34b3cb414`
- GCC 14.1.0 commit `ed10445fe222d3973ae13eda9bf211f315c5e3f9`
- Ubuntu 24.04 with LLVM/Clang/LLD 16 in the build container

ghdl-browser provides the wasm runtime stubs and frontend compatibility
patches. The build removes its simulation-only WAT backend and restores GHDL's
real synthesis implementation. A native build of the same GHDL commit produces
the analyzed `std` and `ieee` libraries shipped beside the module.

## Build

Docker and network access to the pinned upstream repositories are required.
From the repository root:

```bash
tools/ghdl-wasm/build.sh
```

The first run builds native GHDL and populates `.cache/ghdl-wasm`; later runs
reuse that cache. Outputs are written to `web/public/ghdl/`:

- `ghdl-synth.wasm`
- `libraries.tar.gz`
- `SHA256SUMS`

Override the cache or output directory with `GHDL_WASM_CACHE_DIR` and
`GHDL_WASM_OUTPUT_DIR`. Override build parallelism with `GHDL_WASM_JOBS`.

The linker exports only memory allocation, binder initialization, and the
three synthesis API functions. Undefined host functions are a reviewed set of
filesystem, stdio, and math imports implemented by
`web/src/workers/ghdl.worker.ts`.

## Smoke tests

The Node host exercises the same module and standard-library tree without a
browser:

```bash
node tools/ghdl-wasm/ghdl_synth_test.mjs \
  web/public/ghdl/ghdl-synth.wasm \
  .cache/ghdl-wasm/ghdl-native/lib/ghdl \
  counter tools/ghdl-wasm/tests/counter.vhdl
```

The checked fixtures cover simple combinational logic, `ieee.numeric_std`, a
generic counter, an FSM, syntax errors, and semantic errors. The product E2E
tests additionally run the production-built worker in Chromium and assert
VHDL provenance and diagnostics.

## Runtime contract

- Sources are analyzed as VHDL-2008.
- The top entity is required and is matched case-insensitively.
- Files are analyzed in workspace order, so packages must precede units that
  use them.
- A workspace is either VHDL or Verilog/SystemVerilog. Mixed-language
  elaboration is not supported by this two-module architecture.
- GHDL diagnostics are returned before Yosys runs.
- GHDL's `/* file:line:column */` comments are converted to Verilog `` `line ``
  directives. Yosys then emits native `src` attributes pointing to the
  original VHDL file and line. Generated-Verilog columns are not meaningful.

The custom binder step is required: without it, Ada package elaboration does
not run and synthesis tables remain zero-initialized. The `Grt.Stdio` patch
also gives `fputc`, `fflush`, and `fclose` one WebAssembly ABI each; native C
permits ignoring a return value, but WebAssembly rejects conflicting function
signatures.

The Verilog emitter patch writes declarations for GHDL black-box modules.
Upstream tracks those interfaces internally but otherwise omits their module
declarations, leaving the generated top with unresolved cells when Yosys runs.

After rebuilding, update `GHDL_VERSION` in `web/src/lib/yosysScript.ts` with
the new `ghdl-synth.wasm` and `libraries.tar.gz` checksum prefixes. The
precomputed verifier checks both. That value versions browser caches,
precomputed artifacts, and immutable asset URLs for project-local patches and
compiled-library changes as well as upstream GHDL changes.
