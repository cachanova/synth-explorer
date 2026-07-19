# Synth Explorer

[![CI](https://github.com/cachanova/synth-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/cachanova/synth-explorer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Compiler Explorer for RTL.** Paste Verilog, SystemVerilog, or VHDL-2008,
synthesize it with [Yosys](https://yosyshq.net/yosys/) and
[GHDL](https://github.com/ghdl/ghdl), and inspect the resulting circuit by path,
endpoint, fanin, fanout, or source location.

[Try Synth Explorer in your browser](https://www.synthexplorer.dev/)

Synthesis and analysis run locally in the browser. RTL is not uploaded to an
application server. Successful synthesis artifacts are cached only in that
browser profile and can be cleared from the settings menu.

## Features

- Synthesize generic gates, LUT4/LUT6 mappings, and iCE40, ECP5, or Xilinx
  target flows automatically after 250 ms without an edit, using a
  project-pinned Yosys WebAssembly build.
- Analyze and elaborate VHDL-2008 locally with a project-pinned GHDL
  WebAssembly frontend while preserving original file/line provenance.
- Rank logical paths and endpoints by combinational depth.
- Explore bounded fanin and fanout cones without rendering the whole netlist.
- Find high-fanout nets and jump from synthesized cells to source.
- Reuse identical RTL + tool-setting results from a bounded IndexedDB cache.

> [!IMPORTANT]
> Synth Explorer reports structural estimates from a synthesized netlist,
> including unit-delay depth and a rough pre-place-and-route delay estimate. It
> does not perform timing closure. Use nextpnr, OpenSTA, Vivado, or Quartus for
> routed timing analysis.

## Quick start

Requirements are Rust 1.97.1, Node.js 24.11.1, npm 11.6.2, and a current
Chromium browser.

```bash
git clone https://github.com/cachanova/synth-explorer.git
cd synth-explorer/web
npm ci
npm run dev
```

Open <http://localhost:5173>. No backend process, native Yosys, or Vivado
installation is required for the application.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`analysis-core/`](analysis-core/) | Canonical Rust netlist, graph, provenance, grouping, and analysis engine |
| [`analysis-wasm/`](analysis-wasm/) | WebAssembly bindings for the Rust analysis engine |
| [`web/`](web/) | Static React application, browser workers, bundled examples, and pinned WASM artifacts |
| [`tools/yosys-wasm/`](tools/yosys-wasm/) | Reproducible project-owned Yosys WebAssembly build |
| [`tools/ghdl-wasm/`](tools/ghdl-wasm/) | Reproducible project-owned GHDL synthesis WebAssembly build |
| [`calibration/`](calibration/) | Local-only native Yosys and optional licensed Vivado calibration tooling |
| [`docs/`](docs/) | Architecture, migration record, and benchmarks |

Production is the static `web/dist/` output. Vercel serves it through its CDN;
there are no Functions, API routes, databases, persistent volumes, or hosted
EDA tools.

## Development checks

```bash
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings

cd web
npm ci
npm test
npm run lint
npx tsc -b --pretty false
npm run build
npm run test:e2e
```

Rebuild the Rust analysis WebAssembly package with `./analysis-wasm/build.sh`.
See [`tools/yosys-wasm/README.md`](tools/yosys-wasm/README.md) before rebuilding
the much larger Yosys artifact, and [`tools/ghdl-wasm/README.md`](tools/ghdl-wasm/README.md)
before rebuilding the VHDL frontend and standard libraries.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Browser-local migration record](docs/BROWSER_WASM_MIGRATION.md)
- [VHDL WebAssembly architecture](docs/VHDL_GHDL_FEASIBILITY.md)
- [Migration benchmark results](docs/BROWSER_WASM_BENCHMARKS.md)
- [Web client](web/README.md)
- [Local calibration](calibration/README.md)

## License

Synth Explorer is licensed under the [Apache License 2.0](LICENSE).
