# Local Vivado bridge

This small loopback service lets `https://synthexplorer.dev` run synthesis in a
Vivado installation on the same computer as the browser. It is optional; Yosys
and analysis remain browser-local without it.

## Run a release binary

Install and license Vivado first, then download the Windows or Linux bridge from
the [latest Synth Explorer release](https://github.com/cachanova/synth-explorer/releases/latest).

Linux:

```bash
chmod +x synth-explorer-vivado-bridge-linux-x86_64
./synth-explorer-vivado-bridge-linux-x86_64 \
  --vivado /opt/Xilinx/Vivado/2025.2/bin/vivado
```

Windows PowerShell, opened from the Vivado command prompt so `vivado.bat` is on
`PATH`:

```powershell
.\synth-explorer-vivado-bridge-windows-x86_64.exe --vivado vivado.bat
```

The terminal prints a 32-character pairing code. In Synth Explorer, choose
**Vivado (local)** from **Engine** in a current Chromium-based browser, paste
that code, and connect. Keep the terminal open while using Vivado.

## Build from source

Rust 1.97.1 is required.

```bash
git clone https://github.com/cachanova/synth-explorer.git
cd synth-explorer
cargo run --release -p synth-explorer-vivado-bridge -- \
  --vivado /path/to/vivado
```

Use `--allow-origin http://localhost:4173` for a different local preview origin.
The defaults allow the production site and Vite development on port 5173.

## Security and limits

- The bridge refuses non-loopback bind addresses.
- Browser requests need both an allowed exact `Origin` and the per-process
  random pairing code.
- Source filenames, top, target, and `synth_design` tokens are validated before
  a Tcl script is generated; inputs are never interpolated into a shell command.
- Source input is capped at 4 MiB, the returned structural netlist at 64 MiB,
  logs at 64 KiB, runtime at five minutes, and concurrency at one synthesis.
- The concrete target must exist in the part catalog returned by the local
  Vivado installation.

The website receives structural Verilog and normalizes it with its pinned Yosys
WebAssembly build before running the same browser-local Rust analysis used by
the regular flow.
