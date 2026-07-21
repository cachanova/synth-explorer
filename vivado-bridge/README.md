# Local Vivado connector

This small loopback service lets `https://synthexplorer.dev` run synthesis in a
Vivado installation on the same computer as the browser. It is optional; Yosys
and analysis remain browser-local without it.

## Run a release binary

Install and license Vivado first. On Linux, the hosted launcher downloads the
release binary, verifies its checksum, finds Vivado, and starts the connector:

```bash
curl -fsSL https://synthexplorer.dev/vivado | sh
```

If Vivado is not on `PATH`, either load AMD's environment first or pass the exact
binary path:

```bash
source /opt/Xilinx/Vivado/2026.1/settings64.sh
curl -fsSL https://synthexplorer.dev/vivado | env VIVADO_BIN=/opt/Xilinx/Vivado/2026.1/bin/vivado sh
```

You can also download the Windows or Linux binary from the
[latest Synth Explorer release](https://github.com/cachanova/synth-explorer/releases/latest).
The Linux release binary is built as a static `x86_64-unknown-linux-musl`
executable so it does not depend on the host machine's glibc version.

Linux:

```bash
chmod +x synth-explorer-vivado-bridge-linux-x86_64
./synth-explorer-vivado-bridge-linux-x86_64 \
  --vivado /opt/Xilinx/Vivado/2026.1/bin/vivado
```

Windows PowerShell, opened from the Vivado command prompt so `vivado.bat` is on
`PATH`:

```powershell
.\synth-explorer-vivado-bridge-windows-x86_64.exe --vivado vivado.bat
```

In Synth Explorer, choose **Vivado** from **Engine** in a current
Chromium-based browser, then click **Connect local Vivado**. Keep the terminal
open while using Vivado.

## Remote Vivado host

Run the connector on the licensed Linux or Windows Vivado machine. On the laptop
running the browser, open an SSH tunnel to that host:

```bash
ssh -N -L 32123:127.0.0.1:32123 user@vivado-host
```

Keep both terminals open, then connect from the website. The browser still talks
to `127.0.0.1:32123`; SSH forwards that private loopback port to the remote
Vivado host.

## Build from source

Rust 1.97.1 is required.

```bash
git clone https://github.com/cachanova/synth-explorer.git
cd synth-explorer
cargo run --release -p synth-explorer-vivado-bridge -- \
  --vivado /path/to/vivado
```

Use `--allow-origin http://localhost:4173` for a different local preview origin.
The defaults allow the production site. Add an explicit `--allow-origin` for
local previews.

For the most portable Linux binary:

```bash
rustup target add x86_64-unknown-linux-musl
cargo build --release --locked -p synth-explorer-vivado-bridge \
  --target x86_64-unknown-linux-musl
```

## Security and limits

- The bridge refuses non-loopback bind addresses.
- Browser requests need an allowed exact `Origin`. There is no pairing code; the
  user authorizes access by explicitly starting a loopback-only connector.
- Source filenames, top, target, and `synth_design` tokens are validated before
  a Tcl script is generated; inputs are never interpolated into a shell command.
- Source input is capped at 4 MiB, the returned structural netlist at 64 MiB,
  logs at 64 KiB, runtime at five minutes, and concurrency at one synthesis.
- The concrete target must exist in the part catalog returned by the local
  Vivado installation.

The website receives structural Verilog and normalizes it with its pinned Yosys
WebAssembly build before running the same browser-local Rust analysis used by
the regular flow.
