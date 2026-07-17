# Delay-model calibration

## What we are calibrating against

Vivado's `report_timing` on a **synthesized, not placed** design — the same thing
the app reports. It is not timing closure; there is no placement, so both Vivado
and we estimate interconnect rather than measure it.

The canonical fit target is Vivado's estimator run on **our own netlists**:
Yosys `synth_xilinx` output (with the app's `-nowidelut` default), exported as
EDIF and imported into Vivado out-of-context, then timed at the -1 grade. Same
netlist on both sides, so the delay model is the only variable. Do **not** fit
against Vivado timing its own synthesis of the RTL: Vivado's netlist is
structurally different (~2x shallower — LUT6 packing, `SRL16E` inference), so
coefficients fitted to its totals must absorb the depth ratio and cannot also
be physically true. That ill-posed target is what the pre-2026 ~74%-error
coefficients were fitted to.

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
cargo run --example calibrate -- gen ../examples /home/leela/tmp/cal-cases
cargo run --example calibrate -- estimate /home/leela/tmp/cal-cases /home/leela/tmp/est.json
cargo run --example calibrate -- estimate-lattice /home/leela/tmp/cal-cases /home/leela/tmp/lattice-est.json
cargo run --example calibrate -- report /home/leela/tmp/est.json ../calibration/vivado-2026.1.json
cargo run --example calibrate -- fit    ../calibration/vivado-2026.1.json
```

`estimate` runs the three Xilinx families. `estimate-lattice` runs iCE40 and
ECP5 through the production synthesis modes and shipped visible defaults (ECP5
includes `-noiopad`; iCE40 has no such synthesis flag). It also records the
delay-critical path class and endpoint kind so an external timing report can be
paired with the same input/register/output domain instead of whichever domain
the implementation tool happened to print first.

`gen` rewrites parameter *defaults* in the source rather than passing
`-generic`/`chparam`, so Yosys and Vivado read byte-identical RTL and a
discrepancy can never be blamed on parameter plumbing.

### The tcl scripts

| script | emits | for |
|---|---|---|
| `vivado.tcl` | `RESULT:` one JSON record per case/part | whole-path ground truth (`report`/`fit`) |
| `vivado_edif.tcl` | `RESULT:` records, same shape | Vivado's model on **our (Yosys) netlist** |
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

### Timing the Yosys netlist with Vivado (`vivado_edif.tcl`)

Comparing our estimate against `vivado.tcl`'s ground truth is ill-posed: it
varies the delay model *and* the netlist at once (under the pre-`-nowidelut`
default the Yosys netlist ran roughly 2x deeper than Vivado's — about 1.1–1.2x
since — so per-stage coefficients fitted against Vivado's netlist have to
absorb the depth ratio). `vivado_edif.tcl` closes that hole by feeding
the Yosys netlist itself into Vivado over EDIF and running the same
`report_timing` recipe on it. With the netlist held constant:

- estimate vs `vivado_edif.tcl` = pure **delay-model** error, the well-posed
  target for fitting our coefficients;
- `vivado_edif.tcl` vs `vivado.tcl` = pure **mapping** (netlist-shape) error,
  Vivado's model on both sides.

Export one EDIF per case/family with the app's exact baseline synthesis
script — the flags must match what `calibrate estimate` runs (`estimate_case`
in `server/examples/calibrate.rs` is the source of truth), and the script
shape must match `build_script` in `server/src/yosys.rs`, or the two sides are
different netlists again and the comparison is back to being ill-posed. The
app's Xilinx pipeline splits `synth_xilinx` at `fine` to soft-map narrow
(<= 8-bit result) `$alu`/`$lcu` arithmetic away from carry chains, so the
export must replay the same split:

```bash
yosys -q -p "read_verilog -sv <case>/<file>; \
  synth_xilinx -top <top> -flatten -family <xc7|xcu|xcup> <baseline flags> -run begin:fine; \
  select -set narrow_alu t:\$alu r:Y_WIDTH<=8 %i; techmap @narrow_alu; \
  select -set narrow_lcu t:\$lcu r:WIDTH<=8 %i; techmap @narrow_lcu; \
  synth_xilinx -top <top> -flatten -family <xc7|xcu|xcup> <baseline flags> -run fine:; \
  write_edif -pvector bra edif/<case>.<family>.edif"
```

and place them under `<cases-dir>/edif/`. Then, on the Vivado host (chunked —
the host redeploys often, and a redeploy SIGKILLs Vivado and wipes `/tmp`;
trailing case names restrict a run, and reruns are idempotent):

```bash
vivado -nolog -nojournal -mode batch -source vivado_edif.tcl \
  -tclargs <cases-dir> [case ...]
```

Two Vivado traps this flow found, both encoded in the script:

- **Do not pass `-top` to `link_design`** when linking an EDIF. The top comes
  from the EDIF's own `(design ...)` statement; with `-top` Vivado looks for
  RTL sources to elaborate and fails with `[Project 1-68] No files found to
  match top module`. The script verifies the linked `TOP` afterwards instead.
- **Never define a Tcl proc named `try`** in anything sourced into Vivado: it
  shadows the Tcl 8.6 builtin that Vivado's tclapp loader uses, and every
  subsequent `create_project` fails with the unrelated-looking
  `[Common 17-685] Unable to load Tcl app xilinx::xsim`.

The `RESULT:` records have the same shape as `vivado.tcl`'s, so
`calibrate report est.json <edif-results>.json` compares directly. Like the
other vendor-derived datasets, the results stay out of the repo.

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

## Fitting: cells are measured, only the net terms are fitted

The cell terms (`lut_ps`, `carry_ps`, `ff_clk_to_q_ps`, …) are **not fitted**:
they come straight from Vivado's own per-cell charges along real paths of our
EDIF-imported netlists (`cells.tcl` `CELL:` rows, cross-checked against
`speed_models.tcl`). Now that the netlist matches, those physical values
transfer. The one judgment call is `carry_ps`: a single constant cannot
represent chain entry (S→CO, ~533 ps on Series-7) vs cascade (CI→CO, 117 ps),
and the right compromise differs by family. Series-7 uses the corpus-weighted
mean charge per CARRY4 (192 ps). UltraScale/UltraScale+ must use the cascade
arc (35/28 ps): their cascade is nearly free, so Vivado's worst path enters
chains near the top bit and an amortized mean overestimates long chains badly.

### Rejected carry entry/cascade split (2026-07)

Vivado's path rows confirm that entry and cascade are physically different:
Series-7 entry arcs are roughly 448–520 ps versus 117 ps cascade, UltraScale
roughly 327–384 ps versus 35 ps, and UltraScale+ roughly 168–213 ps versus
28 ps. A `carry_entry_ps` experiment charged the first carry cell from a
non-carry predecessor separately and charged later carry-to-carry cells at the
cascade value. The tested entry/propagate pairs were 520/117 ps, 384/35 ps,
and 213/28 ps respectively. It was evaluated with the app's
`-narrowcarry 8 -nowidelut` shape against `edif_nowl.json`, holding out every
zero-logic row.

The split improved several long carry paths but made aggregate family accuracy
worse: Series-7 mean/median absolute error moved 12.9/9.4% to 15.2/10.6%,
UltraScale 18.6/15.8% to 20.5/15.3%, and UltraScale+ 15.4/11.5% to 20.4/13.0%.
The fitted net intercepts already compensate for entry cost across the broader
corpus, so adding a physical entry term without a richer route/path model
double-counts that compensation. The field was therefore not shipped; retain
the flat family coefficients until a split can at least hold aggregate parity.

`net_delay = net_base_ps + net_per_fanout_ps * log2(fanout)` supplies the only
fitted numbers, per family:

- `net_per_fanout_ps` comes from the `NET:` rows (see below).
- `net_base_ps` is then least-squares fitted on the EDIF target's per-case
  totals with every other term held fixed. The Series-7 fit (773 ps) lands
  above the directly measured per-net median (657 ps, per-design spread
  413–947): partly real spread, partly that our worst path may launch from an
  input (zero launch) where Vivado's data path always starts with a clk-to-Q.
  On UltraScale the per-net measurement (252 ps) actively misfits the target —
  Vivado's US/US+ unplaced route estimates are bimodal and often literally
  0.000 — so the fitted values (136/51 ps) are the ones shipped.

When fitting from `NET:` rows, exclude nets whose *sink* is a carry cell —
`net_delay_to_ps` charges those 0 (dedicated routing), so leaving them in drags
every carry-heavy design's intercept toward zero.

**Never fit net terms by pooling nets across designs.** Each design sits at its
own baseline net delay, so a pooled regression measures the design mix, not the
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

## Lattice validation with open tools

The Lattice presets are validated against the app's own netlists with nextpnr;
iCE40 is cross-checked with icetime. The July 2026 run used Yosys 0.64 (the app
runtime) and nextpnr `0.10-86-g261152be` / IceStorm from OSS CAD Suite
2026-07-17. Tool reports are local artifacts, like the Vivado JSON.

Generate each netlist in its own Yosys process and match `build_script` exactly:

```bash
yosys -p 'read_verilog -sv <case.sv>; synth_ice40 -top <top> -flatten; write_json <ice40.json>'
yosys -p 'read_verilog -sv <case.sv>; synth_ecp5 -top <top> -flatten -noiopad; write_json <ecp5.json>'
```

Then place and route with a fixed seed. ECP5 uses out-of-context mode for
internal register paths so nextpnr does not insert I/O or global resources that
the app netlist deliberately omits:

```bash
nextpnr-ice40 --hx8k --package ct256 --seed 1 --threads 1 \
  --timing-allow-fail --json <ice40.json> --asc <out.asc> --report <out.json>
nextpnr-ecp5 --45k --package CABGA381 --speed 6 --out-of-context \
  --seed 1 --threads 1 --timing-allow-fail \
  --json <ecp5.json> --write <routed.json> --report <out.json>
icetime -d hx8k -i -t -j <icetime.json> <out.asc>
```

Compare our `launch + logic + net` with the sum of nextpnr's `clk-to-q`,
`logic`, and `routing` steps; exclude `setup` on both sides. icetime's JSON is
cumulative and includes setup as its final `[setup]` step, so use the preceding
cumulative delay for the same quantity.

Only shape-matched internal register paths are fit inputs. Check model depth
against nextpnr's number of `logic` steps first. I/O-bound runs may be useful
validation, but must not be fitted: nextpnr inserts package I/O and randomly
places unconstrained pins, making those routes systematically slower than the
app's fabric-only pre-place estimate.

The 24-case run found that cell terms already matched. Both net bases were too
high on internal paths: iCE40 included an `Odrv4` stage absent from a local hop,
and ECP5 used one specific span-2 route as its generic base. With only those
intercepts changed, the internal-path results were:

| family | pairs | mean abs error before | after | median before | after | median tool / estimate after |
|---|---:|---:|---:|---:|---:|---:|
| iCE40 HX8K | 5 | 50.8% | 15.7% | 33.0% | 0.1% | 0.999 |
| ECP5 45K grade 6 | 7 | 27.8% | 9.8% | 25.4% | 7.0% | 1.040 |

For transparency, the post-route boundary-path median tool/estimate ratios
after the fit were 1.174 (iCE40) and 3.127 (ECP5). Those numbers measure the
package-I/O and unconstrained-placement gap, not a fabric coefficient error.
Across all 24 cases iCE40 mean absolute error improved from 31.0% to 23.2%; the
ECP5 all-path number moved from 48.8% to 49.8% because its normal-mode boundary
runs add I/O that the shipped `-noiopad` netlist intentionally excludes.

The ECP5 grade factors were also checked end to end over seven internal cases.
Grade 7's least-squares factor was 0.878 (shipped: 0.875). Grade 8 was 0.731 by
least squares and 0.766 by median (shipped: 0.755); placement-sensitive ratios
spanned 0.724-0.883. The existing factors remain within the measured spread.

## What is not calibrated

The `generic` preset remains notional. Lattice I/O/package delay is deliberately
outside these fabric presets, and this validation does not turn the app's
pre-place fabric estimate into timing closure for a user's eventual placed,
routed, and board-constrained design.
