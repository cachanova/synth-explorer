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

## What a post-synthesis path actually looks like

Worth internalising before touching a coefficient — a real `-1` path from
`adder_chain_w16n4`:

```
values[36]  (input port)
net (fo=2, unset)                    0.973   <- input-port route: no placement at all
LUT3 (Prop_lut3_I2_O)                0.124   <- LUT logic is SMALL
net (fo=2, unplaced)                 0.676   <- general route is LARGE
LUT5 (Prop_lut5_I1_O)                0.124
net (fo=2, unplaced)                 0.650
CARRY4 (Prop_carry4_DI[1]_CO[3])     0.520   <- carry-chain entry costs more than
net (fo=1, unplaced)                 0.000      a propagate stage, and the net is FREE
CARRY4 (Prop_carry4_CI_CO[3])        0.117   <- carry propagate
net (fo=1, unplaced)                 0.000
```

Three things this pins down:

* **Carry nets are dedicated.** Carry→carry routes are literally `0.000`, and a
  propagate stage is `0.117 ns`. This is what `net_delay_to_ps` models.
* **Routing dominates, logic doesn't.** A LUT is ~0.124 ns; the net after it is
  ~0.65 ns. At this stage Vivado has no placement, so interconnect is a
  fanout-driven guess and it is *large* — the path above is 73% route. Any fit
  that comes out logic-dominated is fitting something else.
* **The carry-chain entry (`DI->CO`, 0.520 ns) is not a propagate stage
  (`CI->CO`, 0.117 ns).** A single flat `carry_ps` cannot represent both; this is
  the known residual on short carry chains.

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

## What Vivado's estimate actually is

Not a guess on our part — AMD documents the shape. **UG906 p.132,
"Interconnect Setting"**: for post-synthesis designs the estimated net delay
"corresponds to the delay of the best possible placement, based on the **nature
of the driver and loads** as well as the **fanout**".

So the net model is keyed on the **driver→sink pair (+ pin, + fanout, +
family)**, because that is what the tool being modelled is keyed on. Two
consequences:

* It is a **best-case / ideal-placement** estimate, not an ASIC wire-load model
  (UG949 p.223, p.233). No statistics over past designs, no distance, and
  congestion is explicitly not modelled. It is **optimistic by construction** —
  the opposite of the usual "synthesis is pessimistic" folklore.
* AMD publishes **no** fanout table, curve, or coefficients, and no open-source
  project reproduces the pre-placement estimator (RapidWright and Project X-Ray
  both work on placed/routed designs). **Shape from the docs, numbers from
  measurement.**

`calibrate cells` prints the measured numbers and a suggested coefficient row
per family; that output is the fit. Nothing in `delay_model.rs` should be a
number typed in by hand.

## The measured net table (Vivado 2026.1, -1, out-of-context)

Route class matters far more than fanout:

| hop | series7 | ultrascale | why |
|---|---|---|---|
| carry→carry (`CI`) | **0** | **0** | dedicated silicon, UG474 p.47 |
| LUT→carry `S` | **0** | **0** | same-slice LUT `O6`→`S`, UG474 p.44 |
| LUT→carry `DI` | **650** | **362** | general routing — *undocumented*, see below |
| LUT→LUT (general) | **723** | **276** | |
| LUT→FF | **69** | **77** | registers pack into the driving slice |
| any↔port | **973** | **0** | `unset` boundary nets — flat, no fanout term |

### The pin is the thing, not the pair

"LUT→CARRY costs 650 ps on Series-7" is **wrong as stated** — it conflates two
pins. Measured with pin resolution, zero variance within each pin:

* `LUT → CARRY4.S` (select/propagate) is **0 ps on every family**, exactly as
  UG474 p.44's same-slice `O6`→`S` connection predicts.
* `LUT → CARRY4.DI` (data/generate) pays roughly full general routing (650 on
  series7 where general is 723; 362 on ultrascale where general is 276).

Only `DI`'s non-freeness is unexplained: physically it can be sourced from the
LUT's `O5` output, but Vivado's estimate does not price it that way. Treat that
as an empirical property of the tool. Do not re-derive it from first
principles — you will conclude it should be free, and be wrong.

### `unset` is its own category

Vivado labels nets touching an out-of-context boundary `unset`, not `unplaced`.
The word appears nowhere in UG906/UG949/UG835. It is flat — 973 ps on Series-7
at fanout 0, 2 and 31 alike — and on a small design those two boundary nets are
*most* of Vivado's reported route number (`adder_chain_w16n4` series7: route
3.272 = 0.973 + 0.676 + 0.650 + 0 + 0 + 0.973). It is calibrated separately as
`net_port_ps` rather than folded into general routing. On UltraScale it measures
**0**, which is why `reg_mux`'s worst path there is an internal FF→LUT→FF hop
while on Series-7 it is the FF→port hop.

## Fitting the net terms: always use per-design intercepts

`net_delay = <class base> + net_per_fanout_ps * log2(fanout)`.

**Never fit this by pooling nets across designs.** This is now
documentation-confirmed rather than only an empirical scar: since the estimate
keys on driver/load *types* (UG906 p.132), each design sits at its own baseline
set by its type mix, and a pooled regression measures that confound instead of
fanout. On Series-7 the pooled fit reports r = **-0.09** and a *negative* slope
— "post-synthesis routing has no fanout dependence". That is Simpson's paradox:
within `barrel_w32` alone the correlation is r = **+0.95**. `adder_chain_w32n4`'s
nets are all fanout-2 (no variance) and drag the pooled slope to nothing.

Acting on the pooled number would have shipped `net_per_fanout_ps = 0` on the
default profile, quietly making the fanout knob inert. The `calibrate` harness
therefore fits per (family, driver class, sink class), centres within design and
regresses on the residuals, skipping designs with no fanout spread.
`delay_model.rs` has a test asserting general routing grows with fanout; it is
what caught this. If a refit ever forces you to weaken that test, the fit is
wrong.

Even fitted correctly this is the model's weakest term: the within-design
correlation ranges from +1.00 to -0.86 depending on the design, so fanout is not
the only thing driving Vivado's estimate. The per-class base is well determined
and is what actually moves paths.

## The irreducible floor: the two tools do not build the same netlist

Before tuning anything, know what cannot be tuned away. Over the corpus, **our
depth / Vivado's logic levels is median 2.0** (mean 2.13; 33 of 57 pairs are 2x
or worse; only 7 match exactly). Yosys emits LUT chains where Vivado packs LUT6;
Yosys infers FF chains where Vivado infers `SRL16E`; **Yosys emits `MUXF7` where
Vivado builds LUT trees** — Vivado never puts a MUXF on a critical path in this
whole corpus, which is why `wide_mux_ps` has no vendor measurement at all.

Timing a ~2x deeper netlist overestimates however good the per-hop model is.
`calibrate report` therefore prints the error on the `depth == levels` subset
separately: that subset is model error, the rest is mapping quality.

The current split, and why the headline number is the wrong thing to read:

| subset | n | model before the pair fix | after |
|---|---|---|---|
| our depth ≈ Vivado's levels (≤1.35x) | 11 | 50.0% | **11.6%** |
| our depth ≫ Vivado's levels (>1.35x) | 50 | 77.7% | 90.3% |
| whole corpus | 61 | 73.3% | 76.1% |

**The corpus-wide number got slightly worse, and that is the honest sign of a
better model.** Signed error correlates with the depth ratio at r = +0.55. The
old coefficients scored better on the mismatched 50 by cancelling two large
errors — `net_base_ps` was ~3.8x too small, which roughly undid the 2x depth.
That is the same accident that made #51's adders-only corpus report ~6%.

**Do not close the gap by shrinking coefficients** — that turns them into fudge
factors that no longer mean "a LUT costs this much", which is the whole point of
measuring per-arc, and it would restore the cancellation this fix removed. When
the user needs Vivado's netlist timed, the answer is the Vivado backend or a
better Yosys mapping, not a smaller `lut_ps`.

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
