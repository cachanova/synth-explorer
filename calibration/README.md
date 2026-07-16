# Delay-model calibration

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

`report` and `fit` compare our estimate against Vivado ground truth. That data is
a local artifact, not checked in — regenerate it (below) before using them:

```bash
cd server
cargo run --example calibrate -- gen ../examples /tmp/cal-cases
cargo run --example calibrate -- estimate /tmp/cal-cases /tmp/est.json
cargo run --example calibrate -- report /tmp/est.json ../calibration/vivado-2026.1.json
cargo run --example calibrate -- fit    ../calibration/vivado-2026.1.json
```

`gen` rewrites parameter *defaults* in the source rather than passing
`-generic`/`chparam`, so Yosys and Vivado read byte-identical RTL and a
discrepancy can never be blamed on parameter plumbing.

### The tcl scripts

| script | emits | for |
|---|---|---|
| `vivado.tcl` | `RESULT:` one JSON record per case/part | whole-path ground truth (`report`/`fit`) |
| `speed_models.tcl` | `SM: <family> <bel> <arc> <slow_max> <fast_min>` | characterized per-BEL **cell** delays |
| `cells.tcl` | `CELL:`/`NET:` rows of each path table, in path order | **net** terms by driver→sink pair |

`speed_models.tcl` and `cells.tcl` are analysis inputs, not part of the
`gen`/`estimate`/`report`/`fit` pipeline: read their output yourself when
deriving coefficients. In `cells.tcl` output, path order is preserved, so for
each `NET:` row the preceding `CELL:` is the driver and the following one is the
sink.

### Generating the Vivado ground truth

Produces the `vivado-<version>.json` that `report`/`fit` read. Kept out of the
repo; regenerate when you need it. Vivado is licensed and
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

## Exclude `unset` rows

`report_timing` marks each net `unplaced` or `unset`. **Only `unplaced` carries a
real estimate.** On Series-7 every `unset` row is a flat 973 ps — one distinct
value across every driver, sink, and fanout from 1 to 104. That is invariant to
exactly the things UG906 says the estimate keys on, so it is a placeholder, not a
measurement. Including `unset` rows contaminates the pair table and makes clock
nets look like data nets.

## Beware bimodal pairs, and narrow samples

`LUT->CARRY` on Series-7 is bimodal: 50 of 72 routed nets are 0.000 and 22 are
exactly 0.650, with the 0.650 mode appearing in only 2 of 6 designs. A probe over
a handful of designs can land entirely in the minority mode and report 650 as
"the" value — which is how the free-into-carry rule briefly got recorded as wrong.
It is right: the median is 0.000, matching the dedicated carry routing UG474
documents. Always check `zeros` and `distinct` counts before believing a median.

## Fitting the net terms: always use per-design intercepts

`net_delay = net_base_ps + net_per_fanout_ps * log2(fanout)`.

**Never fit this by pooling nets across designs.** Each design sits at its own
baseline net delay, so a pooled regression measures the design mix, not the
silicon. On Series-7 the pooled fit reports r = **-0.09** and a *negative* slope
— "post-synthesis routing has no fanout dependence". That is Simpson's paradox:
within `barrel_w32` alone the correlation is r = **+0.95**. `adder_chain_w32n4`'s
nets are all fanout-2 (no variance) and drag the pooled slope to nothing.

Acting on the pooled number would have shipped `net_per_fanout_ps = 0` on the
default profile, quietly making the fanout knob inert.

The harness does **not** do this fit for you — `calibrate fit` only derives the
speed-grade factors (Vivado -1 vs -N). Fit the net terms yourself, from the
`NET:` rows `cells.tcl` emits: centre `log2(fanout)` and delay within each
design, regress on the residuals for the shared slope, and skip designs with no
fanout spread (they carry no slope information). `delay_model.rs` has a test
asserting `net_delay_ps(10) > net_delay_ps(1)`; it is what caught this. If a
refit ever forces you to weaken that test, the fit is wrong.

Even fitted correctly this is the model's weakest term: the within-design
correlation ranges from +1.00 to -0.86 depending on the design, so fanout is not
the only thing driving Vivado's estimate. `net_base_ps` is well determined and is
what actually moves paths.

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
and are marked not-vendor-calibrated in the `delay_model.rs` module docs. Fitting
them would need Radiant/Diamond. (`icetime` from Project IceStorm has real iCE40
delay data and would be the obvious source if iCE40 ever matters enough.)
