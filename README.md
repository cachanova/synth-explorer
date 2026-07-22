# Synth Explorer

[![CI](https://github.com/cachanova/synth-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/cachanova/synth-explorer/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Compiler Explorer for RTL.** Paste Verilog, SystemVerilog, or VHDL-2008,
synthesize it with [Yosys](https://yosyshq.net/yosys/) and
[GHDL](https://github.com/ghdl/ghdl), and inspect the resulting circuit by path,
endpoint, fanin, fanout, or source location.

[Try Synth Explorer in your browser](https://www.synthexplorer.dev/) or download
the self-contained Chrome launcher for Windows, Linux, or macOS from the
[latest release](https://github.com/cachanova/synth-explorer/releases/latest).

Yosys synthesis and all analysis run locally in the browser. An optional
loopback connector can run Vivado installed on the same computer or through an
SSH tunnel to a licensed remote machine. RTL is never
uploaded to a Synth Explorer application server. Successful synthesis artifacts
are cached only in that browser profile and can be cleared from the settings
menu.

## Features

- Synthesize generic gates, LUT4/LUT6 mappings, and iCE40, ECP5, or Xilinx
  target flows automatically after 250 ms without an edit, using a
  project-pinned Yosys WebAssembly build.
- Analyze and elaborate VHDL-2008 locally with a project-pinned GHDL
  WebAssembly frontend while preserving original file/line provenance.
- Load every bundled design in either Verilog/SystemVerilog or VHDL from the
  toolbar's language toggle.
- Rank logical paths and endpoints by combinational depth.
- Explore bounded fanin and fanout cones without rendering the whole netlist.
- Find high-fanout nets and jump from synthesized cells to source.
- Reuse identical RTL + tool-setting results from a bounded IndexedDB cache.
- Connect the website to a loopback-only local Vivado connector, select from that
  installation's real part catalog, and explore the resulting vendor netlist.

> [!IMPORTANT]
> Yosys/browser flows report structural estimates from a synthesized netlist.
> The optional Vivado flow uses Vivado's own post-synthesis `report_timing`
> output for the timing card. Neither path performs place-and-route timing
> closure inside Synth Explorer.

## Quick start

### Downloadable local application

Install a current Chrome or Chromium browser, then use the download button in
the website header or open the
[latest release](https://github.com/cachanova/synth-explorer/releases/latest).
Every push to `main` builds a complete rolling release from that exact commit,
so this download tracks the latest website source once the build finishes.
Versioned `local-v*` releases remain available as historical snapshots.
Choose the archive for the computer that will run the application:

| Computer | Release asset |
| --- | --- |
| Windows 10/11 x64 | `synth-explorer-local-windows-x86_64.zip` |
| Linux x86-64 | `synth-explorer-local-linux-x86_64.tar.gz` |
| Mac with an Apple chip | `synth-explorer-local-macos-arm64.tar.gz` |
| Mac with an Intel processor | `synth-explorer-local-macos-x86_64.tar.gz` |

On macOS, open **About This Mac**. Choose Apple Silicon when the **Chip** name
begins with Apple; choose Intel when the window lists an Intel **Processor**.

#### Windows

1. Download the Windows ZIP and choose **Extract all**. Do not run the program
   from inside the ZIP preview.
2. Open the extracted `synth-explorer-local` folder and run
   `synth-explorer.exe`.
3. If Microsoft Defender SmartScreen warns about the unsigned current build,
   verify that it came from this repository, then choose **More info** and
   **Run anyway**.
4. Keep the launcher window open while using the Chrome application window.

#### Linux

```bash
tar -xzf synth-explorer-local-linux-x86_64.tar.gz
cd synth-explorer-local
./synth-explorer
```

If the executable bit was removed while copying the folder, restore it with
`chmod +x synth-explorer`. Keep that terminal open while using the application.

#### macOS

1. Download and open the archive matching the Mac's chip.
2. Open the extracted `synth-explorer-local` folder.
3. Current release builds are not signed or notarized. Try to open
   `synth-explorer` once so macOS displays its security warning.
4. Open **System Settings → Privacy & Security**, scroll to **Security**, choose
   **Open Anyway**, then confirm **Open**. Only override this protection after
   verifying the official release and checksum. See
   [Apple's current instructions](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).
5. Keep the Terminal window open while using the Chrome application window.

The extracted executable must remain beside its `web` directory on every
platform. The launcher serves that directory only on `127.0.0.1:32124`, then
opens `http://127.0.0.1:32124/?launcher=1` in Chrome app mode. Yosys, GHDL,
analysis, examples, and browser storage are bundled; no internet connection is
required after download. Closing the launcher stops the local server.

Each archive has a neighboring `.sha256` file. Verify it before running an
unsigned download with `sha256sum -c <file>.sha256` on Linux or
`shasum -a 256 -c <file>.sha256` on macOS. On Windows, compare the value in the
checksum file with `Get-FileHash -Algorithm SHA256 <file>` in PowerShell.

#### Vivado in the local application

On Windows and Linux, the launcher contains the Vivado connector. At startup it
checks `VIVADO_BIN`, `XILINX_VIVADO`, and `PATH` in the background so the Chrome
window can open immediately. Wait for the launcher window to print the Vivado
version before connecting. If necessary, start it with an explicit executable:

On Linux:

```bash
./synth-explorer --vivado /path/to/Vivado/bin/vivado
```

On Windows Command Prompt:

```text
synth-explorer.exe --vivado "C:\Xilinx\Vivado\2025.2\bin\vivado.bat"
```

The built-in connector listens only on `127.0.0.1:32125`. Yosys and GHDL remain
available when Vivado is not installed.

Vivado does not run natively on macOS. Start the standalone released connector
on a licensed Linux or Windows Vivado host, then forward it to the Mac launcher's
dedicated connector port:

```bash
ssh -N -L 32125:127.0.0.1:32123 user@vivado-host
```

Keep the connector and SSH command running, open the macOS launcher, select
**Vivado**, and click **Connect local Vivado**.

### Source checkout

Requirements are Rust 1.97.1, Node.js 24.11.1, npm 11.6.2, and a current
Chromium browser.

```bash
git clone https://github.com/cachanova/synth-explorer.git
cd synth-explorer/web
npm ci
npm run dev
```

Open <http://localhost:5173>. No backend process, native Yosys, or Vivado
installation is required for the default browser-local flow.

## Optional local Vivado

The website contains the complete setup guide: select **Vivado** from
the Tool menu. The short version is:

1. Install and license Vivado on the computer that will run synthesis.
2. On Linux, run `curl -fsSL https://synthexplorer.dev/vivado | sh`; or download
   the Windows/Linux connector from the
   [latest release](https://github.com/cachanova/synth-explorer/releases/latest).
3. If Vivado is not already on `PATH`, run AMD's `settings64.sh` first or pass
   `VIVADO_BIN=/path/to/Vivado/bin/vivado`.
4. In a current Chromium-based browser, select **Vivado** and click
   **Connect local Vivado**. Allow loopback access when the browser asks.

For a remote Vivado host, start the connector on the licensed Linux or Windows
machine, then run `ssh -N -L 32123:127.0.0.1:32123 user@vivado-host` from the
laptop. The connector binds only to `127.0.0.1`, accepts only explicit Synth
Explorer origins, and permits one Vivado run at a time. See
[`vivado-bridge/`](vivado-bridge/) for CLI and source-build instructions.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`analysis-core/`](analysis-core/) | Canonical Rust netlist, graph, provenance, grouping, and analysis engine |
| [`analysis-wasm/`](analysis-wasm/) | WebAssembly bindings for the Rust analysis engine |
| [`web/`](web/) | Static React application, browser workers, bundled examples, and pinned WASM artifacts |
| [`tools/yosys-wasm/`](tools/yosys-wasm/) | Reproducible project-owned Yosys WebAssembly build |
| [`tools/ghdl-wasm/`](tools/ghdl-wasm/) | Reproducible project-owned GHDL synthesis WebAssembly build |
| [`calibration/`](calibration/) | Local-only native Yosys and optional licensed Vivado calibration tooling |
| [`launcher/`](launcher/) | Downloadable loopback Chrome launcher with the built-in Vivado connector |
| [`vivado-bridge/`](vivado-bridge/) | Loopback-only bridge from the static website to a user's local Vivado |
| [`docs/`](docs/) | Current architecture and runtime behavior |

Production is the static `web/dist/` output. Vercel serves it through its CDN;
there are no Functions, hosted API routes, databases, persistent volumes, or
hosted EDA tools.

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
- [VHDL runtime](docs/VHDL_GHDL.md)
- [Web client](web/README.md)
- [Local calibration](calibration/README.md)

## License

Synth Explorer is licensed under the [Apache License 2.0](LICENSE).
