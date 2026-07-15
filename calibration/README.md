# Delay-model calibration

The estimated timing shown in the app comes from the flat coefficients in
`server/src/delay_model.rs`. Those coefficients are **fitted against real Vivado
post-synthesis `report_timing`**, and this directory is how that fit is made and
re-made.

## What we are calibrating against

Vivado's `report_timing` on a **synthesized, not placed** design — the same thing
the app reports. It is not timing closure; there is no placement, so both Vivado
and we estimate interconnect rather than measure it.

The quantity compared is Vivado's **`Data Path Delay`**, which is
clock-to-Q + logic + route. Setup is *not* in it (Vivado folds setup into slack),
so it pairs with our `launch + logic + net` and deliberately excludes our `setup`
term. Comparing against a number that included setup would be an apples/oranges
error worth roughly a `ff_setup_ps` per path.

## Both tools must synthesize the same circuit

Yosys inserts `IBUF`/`OBUF`/`BUFG` for a top-level module; Vivado's
`-mode out_of_context` does not. Timing one against the other silently compares
different circuits — every input→FF path differs by a pad buffer, and the
worst path of a shallow sequential design can end up being the *clock tree*.

So the harness pairs `-noiopad -noclkbuf` (Yosys) with `-mode out_of_context`
(Vivado). Both then produce a bare fabric netlist. That is also the right scope
for these coefficients: pad and clock-tree delay are real but package-dependent,
and the model is about fabric logic.

## Corpus

`cases.json` pins each `examples/` module to concrete parameters. The corpus is
chosen to separate the coefficients rather than just cover the examples:

| case family | isolates |
|---|---|
| `pipe_*` | a bare FF→FF hop: mostly `ff_clk_to_q_ps` + one net |
| `reg_mux_*` | FF→FF through one LUT |
| `adder_chain_*` | carry chains, and chains in series |
| `prio_carry_*` vs `prio_case_*` / `prio_for_*` | the same function on carry vs LUT logic |
| `barrel_*` | mux trees / `MUXF*` (`wide_mux_ps`) |
| `arbiter_*`, `handshake_*`, `fifo_pipe_*` | mixed real logic, as a check rather than a fit |
| `inferred_fifo_*` | memory inference |

`async_fifo_blackbox` is excluded: its IP is a blackbox with no timing arc, so
neither tool has a path through it to compare.

## Running it

Ground truth is checked in (`vivado-2026.1.json`), so the comparison runs with no
Vivado access:

```bash
cd server
cargo run --example calibrate -- gen ../examples /tmp/cal-cases
cargo run --example calibrate -- estimate /tmp/cal-cases /tmp/est.json
cargo run --example calibrate -- report /tmp/est.json ../calibration/vivado-2026.1.json
cargo run --example calibrate -- fit    /tmp/est.json ../calibration/vivado-2026.1.json
```

`gen` rewrites parameter *defaults* in the source rather than passing
`-generic`/`chparam`, so Yosys and Vivado read byte-identical RTL and a
discrepancy can never be blamed on parameter plumbing.

### Regenerating the Vivado ground truth

Only needed when the corpus or the Vivado version changes. Vivado is licensed and
lives in the prod app container; the web path is key-gated for licensing, and the
maintainer drives it over SSH instead. **Non-destructive only** — scratch work in
`/tmp` inside the container, never touching the running app, its data, or config;
remove the scratch dir afterwards.

```bash
tar czf payload.tgz cases vivado.tcl
base64 -w0 payload.tgz | ssh deploy@<prod> "docker exec -i synth-explorer-app-1 \
  bash -lc 'mkdir -p /tmp/cal && cd /tmp/cal && base64 -d > p.tgz && tar xzf p.tgz'"
ssh deploy@<prod> "docker exec -i synth-explorer-app-1 bash -lc \
  'cd /tmp/cal && /opt/AMD/2026.1/Vivado/bin/vivado -nolog -nojournal -mode batch \
   -source vivado.tcl -tclargs cases'" | grep '^RESULT:' | cut -d' ' -f2- \
  | jq -s . > vivado-2026.1.json
```

Base64-pipe the payload rather than quoting scripts through two shells.

## Parts

Speed grade is measured on one device per family, picked so all three grades
exist (`xcku025` only has -1/-2, so UltraScale uses `xcku035`):

| family | device | grades |
|---|---|---|
| series7 | xc7a35t | -1 -2 -3 |
| ultrascale | xcku035 | -1 -2 -3 |
| ultrascale_plus | xcku5p | -1 -2 -3 |

Presets are characterized at **-1**; `fit` derives the -2/-3 multipliers from
Vivado's own -1-vs-N measurements on identical designs.

## What is not calibrated

The Lattice (`ice40`, `ecp5`) and `generic` presets. Vivado cannot target them and
there is no Lattice tool on the host; they are scaled to the same picosecond scale
and are marked not-vendor-calibrated in the module docs and the UI caveat. Fitting
them would need Radiant/Diamond.
