# Synth Explorer local launcher

The local launcher serves the complete static application on
`http://127.0.0.1:32124` and opens it in a dedicated Chrome or Chromium app
window. The downloadable archive includes the launcher and the built `web/`
directory, so Yosys, GHDL, analysis, examples, and workspace persistence work
without internet access.

The launcher also contains the canonical Vivado bridge. At startup it looks for
Vivado using `VIVADO_BIN`, `XILINX_VIVADO/bin/vivado`, then `vivado` on `PATH`.
When found, the existing loopback API starts on `127.0.0.1:32125`. The separate
port prevents an already-running website connector on `32123` from interfering
with the packaged application. Failure to find Vivado does not prevent the
browser-local Yosys and GHDL flows from running.

## Run a packaged download

Extract the complete archive, then run `synth-explorer` on Linux or macOS, or
`synth-explorer.exe` on Windows. On macOS, right-click the launcher and choose
**Open** the first time because the initial release is not notarized. Keep the
launcher window open while using the application.

If Chrome is not found automatically:

```bash
./synth-explorer --chrome /path/to/chrome
```

If Vivado is not found automatically:

```bash
./synth-explorer --vivado /path/to/Vivado/bin/vivado
```

Vivado is not available natively on macOS. Start the separate connector on a
licensed Linux or Windows Vivado host, then forward it to the local launcher's
dedicated connector port:

```bash
ssh -N -L 32125:127.0.0.1:32123 user@vivado-host
```

## Development

Build the static application before running the launcher from the workspace:

```bash
cd web
npm ci
npm run build
cd ..
cargo run -p synth-explorer-launcher -- --web-root web/dist
```
