# Synth Explorer local launcher

The local launcher serves the complete static application on
`http://127.0.0.1:32124` and opens it in a dedicated Chrome or Chromium app
window. The downloadable archive includes the launcher and the built `web/`
directory, so Yosys, GHDL, analysis, examples, and workspace persistence work
without internet access.

The launcher also contains the canonical Vivado bridge, but does not start it at
application startup. When **Vivado** is selected, the local application asks the
launcher to find Vivado using `VIVADO_BIN`, `XILINX_VIVADO/bin/vivado`, then
`vivado` on `PATH`. When found, the loopback API starts on `127.0.0.1:32125`.
If Vivado is not found, the local application prompts for its executable path.
The separate port prevents an already-running website connector on `32123` from
interfering with the packaged application. Yosys and GHDL never start Vivado.

## Run a packaged download

Chrome or Chromium is required. Extract the complete archive and keep the
executable beside the `web` directory.

On Windows, choose **Extract all**, open the resulting
`synth-explorer-local` folder, and run `synth-explorer.exe`. If SmartScreen
warns about the unsigned current build, verify that the archive came from the
official GitHub release before choosing **More info** and **Run anyway**.

On Linux, run:

```bash
tar -xzf synth-explorer-local-linux-x86_64.tar.gz
cd synth-explorer-local
./synth-explorer
```

On macOS, extract the Apple silicon or Intel download and try to open
`synth-explorer` once. Current builds are not signed or notarized. Open
**System Settings → Privacy & Security**, choose **Open Anyway**, then confirm
**Open**. Only override this protection after verifying the official release
and checksum.

Keep the launcher window or terminal open while using the application. Closing
it stops the private loopback server.

If Chrome is not found automatically:

```bash
./synth-explorer --chrome /path/to/chrome
```

On Windows, use `synth-explorer.exe --chrome "C:\path\to\chrome.exe"`.

If Vivado is not found automatically:

```bash
./synth-explorer --vivado /path/to/Vivado/bin/vivado
```

On Windows, use
`synth-explorer.exe --vivado "C:\Xilinx\Vivado\2025.2\bin\vivado.bat"`.

Vivado is not available natively on macOS. Start the separate connector on a
licensed Linux or Windows Vivado host, then forward it to the local launcher's
dedicated connector port:

```bash
ssh -N -L 32125:127.0.0.1:32123 user@vivado-host
```

Keep the connector and SSH command running, select **Vivado** in Synth
Explorer, then click **Connect local Vivado**.

## Development

Build the static application before running the launcher from the workspace:

```bash
cd web
npm ci
npm run build
cd ..
cargo run -p synth-explorer-launcher -- --web-root web/dist
```
