# Synth Explorer

[![CI](https://github.com/cachanova/synth-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/cachanova/synth-explorer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Compiler Explorer for RTL.** Paste Verilog or SystemVerilog, synthesize it
with [Yosys](https://yosyshq.net/yosys/), and inspect the resulting circuit by
path, endpoint, fanin, fanout, or source location.

[Try Synth Explorer in your browser](https://synthexplorer.dev)

## Features

- Synthesize generic gates, LUT4/LUT6 mappings, and iCE40, ECP5, or Xilinx
  target flows.
- Rank logical paths and endpoints by combinational depth.
- Explore bounded fanin and fanout cones without rendering the whole netlist.
- Find high-fanout nets and identify clock, reset, and enable controls.
- Jump from synthesized cells to the Verilog source that produced them.

Synth Explorer also offers a size-capped full-schematic view. The main workflow
focuses on small subgraphs that remain readable as designs grow.

> [!IMPORTANT]
> Synth Explorer reports structural estimates from a synthesized netlist,
> including unit-delay depth and a rough pre-place-and-route delay estimate. It
> does not perform timing closure. Use nextpnr, OpenSTA, Vivado, or Quartus for
> routed timing analysis.

## Quick start

### Requirements

- [Yosys](https://github.com/YosysHQ/yosys) 0.67 or a compatible release
- Rust stable
- Node.js 24.11.1 and npm 11.6.2

Clone the repository, build the frontend, and start the server:

```bash
git clone https://github.com/cachanova/synth-explorer.git
cd synth-explorer/web
npm ci
npm run build
cd ../server
cargo run
```

Open <http://127.0.0.1:8787>. The Rust server hosts the built frontend and the
API on the same origin.

For frontend development, run the server and Vite in separate terminals:

```bash
# Terminal 1
cd server
cargo run

# Terminal 2
cd web
npm ci
npm run dev
```

Vite serves <http://localhost:5173> and proxies `/api` to port 8787.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`server/`](server/) | Rust server, Yosys runner, netlist parser, and graph analysis |
| [`web/`](web/) | React client, CodeMirror editor, and elkjs graph viewer |
| [`examples/`](examples/) | Verilog/SystemVerilog designs used by the UI and tests |
| [`docs/`](docs/) | Architecture, API contract, and operations documentation |
| [`deploy/`](deploy/) | Container, Caddy, deployment, monitoring, and rollback files |

The server keeps synthesized designs in an in-memory, content-addressed cache.
It does not require a database or external credentials.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [API contract](docs/API.md)
- [Maintainer operations](docs/OPERATIONS.md)
- [Web client](web/README.md)

## Development checks

Run backend checks from `server/`:

```bash
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

Run frontend checks from `web/`:

```bash
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run build
```

## Contributing

Bug reports and pull requests are welcome. Open an issue before starting a
large change so maintainers and contributors can agree on the API or product
behavior. Include tests for behavior changes and run the checks for each package
you modify.

## License

Synth Explorer is licensed under the [Apache License 2.0](LICENSE).
