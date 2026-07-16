//! Rough pre-place-and-route timing estimate.
//!
//! This mirrors how a vendor tool (e.g. Vivado) reports *post-synthesis*
//! timing: it sums characterized cell delays with an estimated net delay along
//! the critical logic path. There is no placement or routing, so the
//! interconnect term is an estimate — the same reason a vendor's post-synth
//! numbers are labelled "estimated".
//!
//! # What is documented, what is measured, and what is unexplained
//!
//! Keeping these three apart is what makes this model auditable, so they are
//! labelled throughout rather than blended into one "calibrated" claim.
//!
//! ## Documented (AMD), so the *shape* is not invented
//!
//! **UG906 (Vivado Design Analysis) p.132, "Interconnect Setting"** — the
//! estimate keys on the driver/load types *and* fanout, which is exactly the
//! signature of [`DelayModel::net_delay_ps`]:
//!
//! > This option is automatically set to Estimated for post-synthesis
//! > designs… **Estimated:** For unplaced cells, the net delay value
//! > corresponds to the delay of the best possible placement, based on the
//! > nature of the driver and loads as well as the fanout.
//!
//! Two consequences worth internalising:
//!
//! * It is a **best-case, ideal-placement** estimate, **not** an ASIC-style
//!   wire-load model. UG949 v2022.1 p.223: "Estimated net delays are close to
//!   the best possible placement for all paths"; p.233: "timing analysis uses
//!   estimated delays that correspond to ideal placement". There is no
//!   statistical model of past designs, no distance, and congestion is
//!   explicitly not modelled (UG949 Ch.5). So the estimate is **optimistic by
//!   construction** — which inverts the usual "synthesis is pessimistic"
//!   folklore.
//! * **carry→carry is free** because the silicon says so, not because it fits.
//!   UG474 (7-Series CLB) p.47: dedicated routing connects `CO[3]`→`CI` up a
//!   column of slices; UG574 says the same for CARRY8. Measured 0 ps on every
//!   family.
//!
//! AMD publishes **no** fanout table, curve, or coefficients (not in
//! UG906/UG949/UG835/UG903/UG892), and no open-source project reproduces the
//! pre-placement estimator — RapidWright and Project X-Ray both work on
//! placed/routed designs with real wire/PIP delays. So: **shape from the docs,
//! numbers from measurement.**
//!
//! ## Measured (`calibration/`, real Vivado 2026.1, 12 designs x 3 families)
//!
//! * **General routing dominates and logic does not.** A Series-7 LUT is
//!   ~124-152 ps; the net after it is ~723.
//! * **Registers pack.** A →FF hop is ~69 ps against ~723 for general routing,
//!   which is why `reg_mux` is nearly all logic.
//! * **Port nets are their own category.** Vivado labels a net touching an
//!   out-of-context boundary `unset` rather than `unplaced` and gives it a
//!   *flat* value — 973 ps on Series-7 at fanout 0, 2 and 31 alike, and **0**
//!   on both newer families. `unset` appears nowhere in UG906/UG949/UG835, so
//!   it is a black-box category calibrated separately rather than folded into
//!   general routing. On Series-7 those two boundary nets are most of Vivado's
//!   reported route delay on a small design, so ignoring them is not an option.
//! * **The generational win is routing, not logic.** Series-7 and UltraScale
//!   LUT arcs are ~152 vs ~151 ps. `net_base_ps` is 723 vs 276. Vivado's own
//!   aggregate agrees: `barrel_w32` at 4 logic levels reports logic 0.522 ns on
//!   Series-7 and 0.730 ns on UltraScale.
//! * **Fanout barely matters, except on Series-7.** Fitted on within-design
//!   residuals: +47 ps/log2(fanout) on Series-7, +8 on UltraScale, and -5
//!   (r = -0.14) on UltraScale+ — i.e. unresolvable on the newer fabrics. That
//!   is consistent with an ideal-placement estimate: with no congestion model,
//!   extra loads cost little.
//!
//! ## Unexplained — measured, real, and with no published mechanism
//!
//! **Entering a carry chain depends on the pin, and the `DI` cost is not
//! derivable.** Measured with pin resolution and zero variance within each pin:
//! `LUT → CARRY4.S` is **0 ps on every family**, while `LUT → CARRY4.DI` costs
//! roughly full general routing (650 ps on Series-7 where general is 723; 362
//! on UltraScale where general is 276).
//!
//! The `S` half is exactly what UG474 (7-Series CLB) p.44 predicts — it is fed
//! from the same slice's LUT `O6` output. The `DI` half is not: it can in
//! principle be sourced from the LUT's `O5` output, but Vivado's estimate does
//! not price it that way. Do not re-derive `DI` from first principles — you
//! will conclude it should be free, and be wrong. See
//! [`is_dedicated_carry_pin`].
//!
//! Note this supersedes the older reading that "LUT→CARRY is 650 ps on
//! Series-7 but 33 ps on UltraScale+", which conflated the two pins: the 33 ps
//! was an all-`S` sample.
//!
//! # Accuracy: read the split, not the headline
//!
//! Against `calibration/`'s corpus of real Vivado 2026.1 ground truth. The
//! headline number from #51 (~6%) was an artifact of an adders-only corpus and
//! must not be quoted. Neither should the corpus-wide number below, on its own:
//!
//! | subset | n | old model | this model |
//! |---|---|---|---|
//! | our depth ≈ Vivado's levels (≤1.35x) | 11 | 50.0% | **11.6%** |
//! | our depth ≫ Vivado's levels (>1.35x) | 50 | 77.7% | 90.3% |
//! | whole corpus | 61 | 73.3% | 76.1% |
//!
//! **The corpus-wide number got slightly worse and that is the honest sign of a
//! better model.** Where the two tools build the same structure, error drops
//! ~4x, to 11.6% (`adder_chain_w16n4` -1%, `adder_chain_w32n4` -1%,
//! `fifo_pipe_w16_s3` +1%, `reg_mux` +2%). Where they don't, we now overestimate
//! — because the per-hop costs are finally right and we are applying them to a
//! netlist that is a median **2.0x deeper** than Vivado's.
//!
//! The old model scored better there by cancelling two large errors: its
//! `net_base_ps` was ~3.8x too small, which roughly undid the extra depth. That
//! is the same accident that made the adders-only corpus report ~6%. Fitting the
//! coefficients back down to restore it would re-break them — they would stop
//! meaning "a LUT costs this much", which is the entire point of measuring
//! per-arc. Signed error correlates with the depth ratio at r = +0.55.
//!
//! So the residual on the mismatched 50 is **mapping quality, not model error**:
//! Yosys emits LUT chains where Vivado packs LUT6, FF chains where Vivado infers
//! `SRL16E`, and `MUXF7` where Vivado builds LUT trees (our depth 28 vs Vivado's
//! 15 levels on `prio_carry_w64`; `arbiter_n4` depth 6 vs levels 1). The fix for
//! those is a better mapping or the Vivado backend — not a smaller `lut_ps`.
//! `calibration/README.md` quantifies the split.
//!
//! Treat the estimate as a **relative** guide — depth and delay ordering are far
//! more trustworthy than the absolute picoseconds. Post-synthesis timing is a
//! necessary-not-sufficient gate in AMD's own framing (UG949 Ch.1: "if
//! post-synthesis timing is not met, placement and routing results are not
//! likely to meet timing"), and only a fully routed design is valid for signoff
//! (UG906 p.126).
//!
//! The Lattice (iCE40/ECP5) and `generic` presets are NOT vendor-calibrated
//! (no Lattice tool available); they are scaled to the same picosecond scale.
//! Every coefficient is a flat, tunable number so a request can override any of
//! them. This is still a pre-place-and-route estimate, NOT timing closure.

use serde::{Deserialize, Serialize};

/// Which device family's characterization a set of coefficients came from.
///
/// Kept separate from [`DelayModel`] on purpose. `DelayModel` is a bag of
/// numbers the user may freely edit; the profile is the *identity* of the
/// silicon those numbers describe. Speed-grade scaling is a property of the
/// silicon — Series-7 gains far more from a -3 grade than UltraScale+ does — so
/// it has to key on this rather than on the coefficient values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DelayProfile {
    Series7,
    UltraScale,
    UltraScalePlus,
    Ice40,
    Ecp5,
    Generic,
}

impl DelayProfile {
    /// The baseline (-1 speed grade) coefficients for this family.
    pub fn model(self) -> DelayModel {
        match self {
            Self::Series7 => DelayModel::series7(),
            Self::UltraScale => DelayModel::ultrascale(),
            Self::UltraScalePlus => DelayModel::ultrascale_plus(),
            Self::Ice40 => DelayModel::ice40(),
            Self::Ecp5 => DelayModel::ecp5(),
            Self::Generic => DelayModel::generic(),
        }
    }

    /// Parse a profile name from a request. Unknown names fall back to Series-7,
    /// matching the historical default.
    pub fn from_name(name: Option<&str>) -> Self {
        match name {
            Some("ultrascale") => Self::UltraScale,
            Some("ultrascale_plus") => Self::UltraScalePlus,
            Some("ice40") => Self::Ice40,
            Some("ecp5") => Self::Ecp5,
            Some("generic") => Self::Generic,
            _ => Self::Series7,
        }
    }

    /// Pick the default profile for a synthesis target. `mode` is the
    /// [`crate::yosys::SynthMode`] string; `family` is the Xilinx `-family`
    /// value when one was supplied, else `None`.
    pub fn for_target(mode: &str, family: Option<&str>) -> Self {
        match mode {
            "xilinx" => match family.map(str::to_ascii_lowercase).as_deref() {
                // Yosys spells these `xcup` / `xcu`; the rest are defensive
                // aliases for family strings arriving from other backends.
                Some("xcup" | "xcvup" | "xcau" | "xczu") => Self::UltraScalePlus,
                Some("xcu" | "xcvu" | "xcku") => Self::UltraScale,
                // xc7, xc6s/xc6v (Spartan/Virtex-6), or unspecified → 7-series.
                _ => Self::Series7,
            },
            "ice40" => Self::Ice40,
            "ecp5" => Self::Ecp5,
            // gates / lut4 / lut6 / rtl and anything unrecognized.
            _ => Self::Generic,
        }
    }

    /// Multiplier applied to every coefficient for a speed grade, relative to
    /// the "-1" the presets are characterized at.
    ///
    /// Measured, per family, from Vivado 2026.1's own -1-vs-N `report_timing` on
    /// identical designs (`calibration/vivado-2026.1.json`). The spread is real:
    /// Series-7 gains ~28% from a -3 grade while UltraScale+ gains ~20%, because
    /// the newer fabric is already fast and has less headroom to sell.
    ///
    /// One factor covers logic and routing together. Vivado does scale them
    /// differently, but *which* one gains more flips between families
    /// (Series-7 routing gains more; UltraScale logic does), so splitting the
    /// term would encode that inconsistency as though it were signal.
    ///
    /// The Lattice and generic profiles have no vendor measurement; they keep
    /// the old hand-picked factors.
    pub fn speed_grade_factor(self, grade: Option<&str>) -> f64 {
        match (self, grade) {
            (Self::Series7, Some("-2")) => 0.799,
            (Self::Series7, Some("-3")) => 0.715,
            (Self::UltraScale, Some("-2")) => 0.838,
            (Self::UltraScale, Some("-3")) => 0.738,
            (Self::UltraScalePlus, Some("-2")) => 0.860,
            (Self::UltraScalePlus, Some("-3")) => 0.795,
            // Not vendor-measured.
            (_, Some("-2")) => 0.87,
            (_, Some("-3")) => 0.78,
            // "-1" or unspecified: the baseline the presets are characterized at.
            _ => 1.0,
        }
    }
}

/// The delay-relevant category of a cell.
///
/// This is the "nature of the driver and loads" that UG906 p.132 says Vivado's
/// estimated net delay keys on, so it is the unit both the net model and the
/// calibration harness classify by — one implementation, so the fit and the
/// shipped model cannot drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CellClass {
    /// LUT / generic logic gate.
    Lut,
    /// Carry-chain primitive (CARRY4/CARRY8/MUXCY/…).
    Carry,
    /// Wide-mux resource (MUXF7/8/…).
    WideMux,
    /// Register / other sequential cell.
    Reg,
    /// A top-level port boundary rather than a cell.
    Port,
    /// Anything else (block RAM, DSP, …).
    Other,
}

impl CellClass {
    /// Classify a cell type name. Case-insensitive; accepts Yosys (`$_XOR_`,
    /// `$dff`) and vendor (`LUT6`, `CARRY4`, `FDRE`) spellings alike.
    pub fn of(cell_type: &str) -> Self {
        let upper = cell_type.to_ascii_uppercase();
        if is_carry(&upper) {
            Self::Carry
        } else if is_wide_mux(&upper) {
            Self::WideMux
        } else if is_lut(&upper) {
            Self::Lut
        } else if is_reg(&upper) {
            Self::Reg
        } else {
            Self::Other
        }
    }

    /// Classify a graph node's optional cell type. A node with no cell type is
    /// a port boundary (or a constant), not a cell.
    pub fn of_opt(cell_type: Option<&str>) -> Self {
        cell_type.map_or(Self::Port, Self::of)
    }
}

/// Tunable delay coefficients (picoseconds). See module docs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DelayModel {
    /// LUT / generic logic-gate propagation.
    pub lut_ps: f64,
    /// One carry-chain stage (CARRY4/MUXCY/…) — fast per bit.
    pub carry_ps: f64,
    /// Wide-mux resource (MUXF7/8/…).
    pub wide_mux_ps: f64,
    /// Any other combinational cell.
    pub cell_ps: f64,
    /// Register clock-to-Q (launch at a path startpoint).
    pub ff_clk_to_q_ps: f64,
    /// Register setup (capture at a path endpoint).
    pub ff_setup_ps: f64,
    /// General-routing interconnect estimate (LUT→LUT and anything without a
    /// more specific rule below).
    pub net_base_ps: f64,
    /// Added per sink on the net (fanout term).
    pub net_per_fanout_ps: f64,
    /// Interconnect into a carry chain's **`DI`** (data/generate) input from a
    /// non-carry driver.
    ///
    /// Per-family and **empirical**. The `S` (select/propagate) input is free
    /// on every family measured; `DI` is not. See module docs.
    pub net_carry_entry_ps: f64,
    /// Interconnect into a register (LUT→FF). Registers pack into the slice
    /// that drives them, so this is well under general routing.
    pub net_to_reg_ps: f64,
    /// Interconnect on a net touching a top-level port boundary.
    ///
    /// Vivado labels these `unset` rather than `unplaced` and gives them a flat
    /// value regardless of fanout — see module docs.
    pub net_port_ps: f64,
}

impl Default for DelayModel {
    fn default() -> Self {
        Self::series7()
    }
}

impl DelayModel {
    /// Xilinx 7-series (28nm, xc7a35t -1).
    ///
    /// Every number here is `calibrate cells`' output over 12 designs of real
    /// Vivado 2026.1 `report_timing`, except `wide_mux_ps` and `cell_ps` — see
    /// below. Reproduce with
    /// `calibrate cells ../calibration/cells-2026.1.txt` from `server/`.
    ///
    /// Notable measurements, because they are not what you would guess:
    /// * `lut_ps` 152: the **occurrence-weighted mean** LUT arc. The
    ///   distribution is bimodal — 124 ps in 609 of 845 samples, with a second
    ///   cluster at ~295-321 — and the model sums many LUTs along a path, so
    ///   the mean is the right single-value predictor even though 124 is the
    ///   mode. The old 360 was ~2.4x too slow.
    /// * `net_base_ps` 723 vs the old 190: **routing dominates and logic does
    ///   not**. A LUT is ~124-152 ps; the net after it is ~723.
    /// * `net_port_ps` 973: flat, and on a small design these two boundary nets
    ///   are most of Vivado's whole route number.
    pub fn series7() -> Self {
        Self {
            lut_ps: 152.0,
            carry_ps: 117.0,
            // NOT vendor-measured: Vivado never puts a MUXF on a critical path
            // in this corpus (it maps wide muxes to LUT trees where Yosys emits
            // MUXF7), so there is no arc to measure. A MUXF7 is a 2:1 slice mux
            // fed from two LUT outputs and is not slower than a LUT, so it is
            // pinned to `lut_ps` as a first-order stand-in.
            wide_mux_ps: 152.0,
            cell_ps: 152.0,
            ff_clk_to_q_ps: 458.0,
            ff_setup_ps: 40.0,
            net_base_ps: 723.0,
            net_per_fanout_ps: 47.0,
            net_carry_entry_ps: 650.0,
            net_to_reg_ps: 69.0,
            net_port_ps: 973.0,
        }
    }

    /// Xilinx UltraScale (20nm, xcku035 -1).
    ///
    /// Two results here are counterintuitive and both are measured twice
    /// (per-arc, and in Vivado's own aggregate `logic`/`route` columns):
    ///
    /// * **UltraScale logic is not faster than Series-7.** `lut_ps` comes out
    ///   at ~151 vs Series-7's ~152. This is cross-validated against a
    ///   completely independent statistic — Vivado's own aggregate `logic`
    ///   column at *identical* logic levels: 8 of 11 matched-level cases have
    ///   UltraScale logic **slower**, by up to 1.8x (`barrel_w64` 4 levels:
    ///   0.496 ns on Series-7 vs 0.769 ns here). The 3 that are faster are all
    ///   1-level paths dominated by clock-to-Q, which genuinely is ~3x faster
    ///   (458 -> 140 ps). The generational win is **routing** (`net_base_ps`
    ///   276 vs 723), **carry**, and **clock-to-Q** — not the LUT.
    /// * **Port nets are free.** `net_port_ps` is 0 — every boundary net
    ///   measured 0.000 ns, against a flat 973 on Series-7. That is why
    ///   `reg_mux`'s worst path here is an internal FF→LUT→FF hop rather than
    ///   the FF→port hop that wins on Series-7.
    ///
    /// `carry_ps` is per **Yosys `CARRY4`**: Yosys emits CARRY4 for every
    /// family while Vivado uses CARRY8 here, so the measured CARRY8 propagate
    /// is reduced to a per-bit rate and scaled to 4 bits.
    pub fn ultrascale() -> Self {
        Self {
            lut_ps: 151.0,
            carry_ps: 18.0,
            // NOT vendor-measured — see `series7`.
            wide_mux_ps: 151.0,
            cell_ps: 151.0,
            ff_clk_to_q_ps: 140.0,
            ff_setup_ps: 30.0,
            net_base_ps: 276.0,
            net_per_fanout_ps: 8.0,
            net_carry_entry_ps: 362.0,
            net_to_reg_ps: 77.0,
            net_port_ps: 0.0,
        }
    }

    /// Xilinx UltraScale+ (16nm FinFET, xcku5p -1).
    ///
    /// Measured over 10 of the 12 probe designs (`handshake_t16` and
    /// `fifo_pipe_w16_s3` are missing — the prod Vivado host recreates its
    /// container every few minutes and those two never completed a run). The 10
    /// span carry chains, LUT trees and FF hops. Two coefficients are **not**
    /// measured:
    ///
    /// * `net_per_fanout_ps` is **0**, not fitted. The within-design fit gives
    ///   -5 ps/log2(fanout) at r = -0.14 over 247 samples in 8 designs — i.e.
    ///   indistinguishable from zero, and a *negative* fanout term is
    ///   unphysical (more loads never routes faster). UltraScale measures +8 at
    ///   r = 0.50. So fanout has no resolvable effect on the newer fabrics'
    ///   ideal-placement estimate; only Series-7 (+47) shows a real one. Set to
    ///   zero rather than shipping a negative slope or inventing a positive
    ///   one.
    /// * `net_carry_entry_ps` is **inferred**, not measured: across all 10
    ///   designs Vivado never routes a `LUT → CARRY.DI` hop onto a critical
    ///   path here — every carry entry in the corpus is the free `S` pin — so
    ///   there is no sample to fit. It is set to `net_base_ps` because that is
    ///   what `DI` measured on both families that do have samples (650 vs 723
    ///   general on Series-7; 362 vs 276 on UltraScale). If a design ever does
    ///   enter a chain via `DI` here, measure it rather than trusting this.
    ///
    /// `net_port_ps` is 0, matching UltraScale: boundary nets are free on both
    /// newer families and cost a flat 973 ps on Series-7.
    pub fn ultrascale_plus() -> Self {
        Self {
            lut_ps: 96.0,
            carry_ps: 15.0,
            // NOT vendor-measured — see `series7`.
            wide_mux_ps: 96.0,
            cell_ps: 96.0,
            ff_clk_to_q_ps: 93.0,
            ff_setup_ps: 25.0,
            net_base_ps: 198.0,
            net_per_fanout_ps: 0.0,
            net_carry_entry_ps: 198.0,
            net_to_reg_ps: 63.0,
            net_port_ps: 0.0,
        }
    }

    /// Lattice iCE40 (40nm) — a small, comparatively slow fabric. NOT
    /// vendor-calibrated (no Lattice tool here); scaled slower than Series-7.
    ///
    /// The per-class net terms are derived from Series-7's *measured ratios*
    /// (see [`uncalibrated_net_terms`]) rather than invented independently:
    /// with no Lattice tool there is nothing to measure, and borrowing the one
    /// family we did measure at least keeps the classes internally consistent.
    pub fn ice40() -> Self {
        let (carry_entry, to_reg, port) = uncalibrated_net_terms(320.0);
        Self {
            lut_ps: 480.0,
            carry_ps: 90.0,
            wide_mux_ps: 480.0,
            cell_ps: 480.0,
            ff_clk_to_q_ps: 800.0,
            ff_setup_ps: 60.0,
            net_base_ps: 320.0,
            net_per_fanout_ps: 70.0,
            net_carry_entry_ps: carry_entry,
            net_to_reg_ps: to_reg,
            net_port_ps: port,
        }
    }

    /// Lattice ECP5 (40nm). NOT vendor-calibrated; scaled from Series-7, net
    /// classes included (see [`uncalibrated_net_terms`]).
    pub fn ecp5() -> Self {
        let (carry_entry, to_reg, port) = uncalibrated_net_terms(280.0);
        Self {
            lut_ps: 420.0,
            carry_ps: 90.0,
            wide_mux_ps: 420.0,
            cell_ps: 420.0,
            ff_clk_to_q_ps: 650.0,
            ff_setup_ps: 55.0,
            net_base_ps: 280.0,
            net_per_fanout_ps: 60.0,
            net_carry_entry_ps: carry_entry,
            net_to_reg_ps: to_reg,
            net_port_ps: port,
        }
    }

    /// Technology-neutral preset for the non-silicon modes (generic gates, LUT
    /// metric, RTL). These modes are not a real device, so the figure is purely
    /// notional — it exists to keep the relative depth-vs-delay signal sensible.
    pub fn generic() -> Self {
        let (gen_carry, gen_to_reg, gen_port) = uncalibrated_net_terms(200.0);
        Self {
            lut_ps: 300.0,
            carry_ps: 250.0,
            wide_mux_ps: 300.0,
            cell_ps: 320.0,
            ff_clk_to_q_ps: 500.0,
            ff_setup_ps: 40.0,
            net_base_ps: 200.0,
            net_per_fanout_ps: 50.0,
            net_carry_entry_ps: gen_carry,
            net_to_reg_ps: gen_to_reg,
            net_port_ps: gen_port,
        }
    }

    /// Pick the default preset for a synthesis target. `mode` is the
    /// [`crate::yosys::SynthMode`] string; `family` is the Xilinx `-family`
    /// value (e.g. `xcup`) when one was supplied, else `None`.
    pub fn for_target(mode: &str, family: Option<&str>) -> Self {
        DelayProfile::for_target(mode, family).model()
    }

    /// Scale every coefficient by `factor` — used to model speed grade. A faster
    /// grade characterizes the whole device (logic, registers, and nets) faster,
    /// so a single multiplier is a reasonable first-order knob. `factor` is
    /// clamped to a sane positive range.
    #[must_use]
    pub fn scaled(self, factor: f64) -> Self {
        let f = factor.clamp(0.1, 10.0);
        Self {
            lut_ps: self.lut_ps * f,
            carry_ps: self.carry_ps * f,
            wide_mux_ps: self.wide_mux_ps * f,
            cell_ps: self.cell_ps * f,
            ff_clk_to_q_ps: self.ff_clk_to_q_ps * f,
            ff_setup_ps: self.ff_setup_ps * f,
            net_base_ps: self.net_base_ps * f,
            net_per_fanout_ps: self.net_per_fanout_ps * f,
            net_carry_entry_ps: self.net_carry_entry_ps * f,
            net_to_reg_ps: self.net_to_reg_ps * f,
            net_port_ps: self.net_port_ps * f,
        }
    }

    /// Propagation delay of a combinational cell by rough category.
    pub fn cell_delay_ps(&self, cell_type: &str) -> f64 {
        let upper = cell_type.to_ascii_uppercase();
        if is_carry(&upper) {
            self.carry_ps
        } else if is_wide_mux(&upper) {
            self.wide_mux_ps
        } else if is_lut(&upper) {
            self.lut_ps
        } else {
            self.cell_ps
        }
    }

    /// Estimated interconnect delay for one `driver` → `sink` hop on a net with
    /// `fanout` sinks.
    ///
    /// The signature keys on the **driver→sink pair** because that is what
    /// Vivado's estimate keys on. UG906 (Vivado Design Analysis) p.132,
    /// "Interconnect Setting": for post-synthesis designs the estimated net
    /// delay "corresponds to the delay of the best possible placement, based on
    /// the nature of the driver and loads as well as the fanout". A
    /// fanout-only signature cannot express that, and the previous one
    /// (`sink` alone) got Series-7 carry entry wrong by ~650 ps a hop.
    ///
    /// The rules, and how much each is trusted:
    ///
    /// * **carry→carry is free** — dedicated silicon, not a fitted number.
    ///   UG474 (7-Series CLB) p.47: the `CO[3]`→`CI` connection uses "dedicated
    ///   routing [that] connects the carry chain up a column of slices". Same
    ///   for CARRY8 on UltraScale (UG574). Measured 0.000 on every family.
    /// * **→carry from anything else** is [`Self::net_carry_entry_ps`], and is
    ///   purely empirical — see the module docs. It is *not* derivable.
    /// * **port nets** are flat [`Self::net_port_ps`]: Vivado calls them
    ///   `unset` and does not vary them with fanout.
    /// * **→register** is [`Self::net_to_reg_ps`] (slice-local packing).
    /// * everything else is general routing.
    ///
    /// The fanout term grows with log2(fanout) — high-fanout nets get
    /// buffered/replicated in real routing, so a linear model wildly
    /// overestimates them.
    pub fn net_delay_ps(
        &self,
        driver: CellClass,
        sink: CellClass,
        sink_pin: Option<&str>,
        fanout: u32,
    ) -> f64 {
        let fanout_term = self.net_per_fanout_ps * f64::from(fanout.max(1)).log2();
        match (driver, sink) {
            // Dedicated carry routing: documented silicon (UG474 p.47).
            (CellClass::Carry, CellClass::Carry) => 0.0,
            // A boundary net. Flat by measurement, and it does not carry the
            // fanout term because Vivado does not vary it with fanout.
            (CellClass::Port, _) | (_, CellClass::Port) => self.net_port_ps,
            // Entering a carry chain: which PIN decides, not the pair alone.
            (_, CellClass::Carry) => {
                if is_dedicated_carry_pin(sink_pin) {
                    0.0
                } else {
                    self.net_carry_entry_ps + fanout_term
                }
            }
            (_, CellClass::Reg) => self.net_to_reg_ps + fanout_term,
            _ => self.net_base_ps + fanout_term,
        }
    }

    /// Launch delay at a path startpoint: a register contributes clock-to-Q, a
    /// top-level input contributes nothing (arrival time zero).
    pub fn launch_ps(&self, sequential: bool) -> f64 {
        if sequential { self.ff_clk_to_q_ps } else { 0.0 }
    }
}

/// Per-class net terms for a profile with **no vendor measurement**, derived
/// from `general` (its `net_base_ps`) using Series-7's measured ratios.
///
/// Returns `(net_carry_entry_ps, net_to_reg_ps, net_port_ps)`.
///
/// There is no Lattice tool on the host and Vivado cannot target iCE40/ECP5, so
/// these classes cannot be measured. Inventing three independent numbers per
/// profile would be worse than borrowing the shape of the one family we did
/// measure: on Series-7 a carry `DI` entry costs ~0.9x general routing, a →FF
/// hop ~0.1x, and a boundary net ~1.35x. That at least keeps the classes
/// ordered and internally consistent. These are **not** vendor-calibrated and
/// must not be quoted as if they were.
fn uncalibrated_net_terms(general: f64) -> (f64, f64, f64) {
    (
        (general * 0.9).round(),
        (general * 0.1).round(),
        (general * 1.35).round(),
    )
}

/// Whether a carry-chain input pin is reached by a dedicated intra-slice
/// connection rather than general routing.
///
/// Measured, and the split is sharp — Series-7, Vivado 2026.1, zero variance
/// within each pin:
///
/// | arc | estimated route |
/// |---|---|
/// | `LUT → CARRY4.S` (select/propagate) | **0 ps** |
/// | `LUT → CARRY4.DI` (data/generate) | **650 ps** (= general routing) |
///
/// `S` is driven from the same slice's LUT `O6` output, which is the dedicated
/// path UG474 (7-Series CLB) p.44 describes. `DI` can in principle come from
/// the LUT `O5` output, but Vivado's pre-placement estimate does not price it
/// that way — it charges full general routing. That asymmetry is empirical and
/// undocumented; see the module docs.
///
/// `CI`/`CYINIT` are the chain's own carry-in and are handled by the
/// carry→carry rule before this is consulted.
fn is_dedicated_carry_pin(pin: Option<&str>) -> bool {
    let Some(pin) = pin else {
        return false;
    };
    // Yosys spells these `S`, `DI`, `CI`, `CYINIT`; a bit index (`S[3]`) is
    // which bit of the slice, not a different route.
    let base = pin.split('[').next().unwrap_or(pin).to_ascii_uppercase();
    matches!(base.as_str(), "S" | "CI" | "CYINIT")
}

fn is_carry(upper: &str) -> bool {
    matches!(upper, "MUXCY" | "XORCY" | "SB_CARRY")
        || upper.starts_with("CARRY")
        || upper.starts_with("CCU2")
}

fn is_wide_mux(upper: &str) -> bool {
    upper.starts_with("MUXF") || matches!(upper, "PFUMX" | "L6MUX21")
}

/// Whether a cell is sequential. Mirrors the vendor and Yosys spellings the
/// netlist can carry; `SRL*` is a shift-register lookup and is sequential too.
fn is_reg(upper: &str) -> bool {
    upper.starts_with("FD")
        || upper.starts_with("SRL")
        || upper.starts_with("LD")
        || upper.starts_with("SB_DFF")
        || upper.starts_with("$DFF")
        || upper.starts_with("$SDFF")
        || upper.starts_with("$ADFF")
        || upper.starts_with("$ALDFF")
        || upper.starts_with("$DLATCH")
        || upper.starts_with("$ADLATCH")
        || upper == "$FF"
}

fn is_lut(upper: &str) -> bool {
    upper.starts_with("LUT")
        || upper.starts_with("SB_LUT")
        || upper == "$LUT"
        // generic gate cells emitted in `gates` mode: $_AND_, $_XOR_, $_MUX_, …
        || (upper.starts_with("$_") && upper.ends_with('_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorizes_cells_and_scales_net_delay_with_fanout() {
        let m = DelayModel::default();
        assert_eq!(m.cell_delay_ps("CARRY4"), m.carry_ps);
        assert_eq!(m.cell_delay_ps("MUXF7"), m.wide_mux_ps);
        assert_eq!(m.cell_delay_ps("LUT6"), m.lut_ps);
        assert_eq!(m.cell_delay_ps("$_XOR_"), m.lut_ps);
        assert_eq!(m.cell_delay_ps("FDRE"), m.cell_ps);
        assert_eq!(m.launch_ps(true), m.ff_clk_to_q_ps);
        assert_eq!(m.launch_ps(false), 0.0);
    }

    /// The fanout knob must actually move general routing.
    ///
    /// This is the test that caught the pooled-regression bug described in
    /// `calibration/README.md`: fitting the fanout term across designs reports a
    /// *negative* slope (Simpson's paradox on the driver/load type mix) and
    /// would ship `net_per_fanout_ps = 0`, silently making the knob inert. If a
    /// refit ever forces this test to be weakened, the fit is wrong.
    #[test]
    fn net_delay_grows_with_fanout_on_general_routing() {
        let m = DelayModel::default();
        let general = |fo| m.net_delay_ps(CellClass::Lut, CellClass::Lut, None, fo);
        assert!(general(10) > general(1));
        // fanout 0 is treated as 1 rather than producing log2(0) = -inf
        assert_eq!(general(0), general(1));
    }

    #[test]
    fn carry_chain_nets_are_dedicated_by_pin_not_by_cell() {
        let m = DelayModel::series7();
        // carry->carry is dedicated silicon (UG474 p.47): free on every family,
        // whatever the fanout or pin.
        assert_eq!(
            m.net_delay_ps(CellClass::Carry, CellClass::Carry, Some("CI"), 4),
            0.0
        );
        // Entering a chain: the PIN decides. `S` rides the same-slice LUT->carry
        // connection and is free; `DI` pays general routing. Averaging these two
        // into one "LUT->CARRY" number describes neither — that conflation is
        // what made the old rule wrong by ~650 ps a hop on Series-7.
        assert_eq!(
            m.net_delay_ps(CellClass::Lut, CellClass::Carry, Some("S[1]"), 1),
            0.0
        );
        assert!(m.net_delay_ps(CellClass::Lut, CellClass::Carry, Some("DI[1]"), 1) > 0.0);
        // Everything else is general routing.
        assert_eq!(
            m.net_delay_ps(CellClass::Lut, CellClass::Lut, Some("I0"), 4),
            m.net_base_ps + m.net_per_fanout_ps * 2.0
        );
    }

    #[test]
    fn a_net_touching_a_port_is_flat_and_ignores_fanout() {
        // Vivado labels boundary nets `unset` and gives them the same value at
        // fanout 0, 2 and 31 alike — so the fanout term must not apply.
        let m = DelayModel::series7();
        for fo in [0, 1, 2, 31] {
            assert_eq!(
                m.net_delay_ps(CellClass::Lut, CellClass::Port, None, fo),
                m.net_port_ps
            );
            assert_eq!(
                m.net_delay_ps(CellClass::Port, CellClass::Lut, Some("I0"), fo),
                m.net_port_ps
            );
        }
    }

    #[test]
    fn classifies_yosys_and_vendor_cell_spellings() {
        assert_eq!(CellClass::of("LUT6"), CellClass::Lut);
        assert_eq!(CellClass::of("$_XOR_"), CellClass::Lut);
        assert_eq!(CellClass::of("CARRY4"), CellClass::Carry);
        assert_eq!(CellClass::of("CARRY8"), CellClass::Carry);
        assert_eq!(CellClass::of("MUXF7"), CellClass::WideMux);
        assert_eq!(CellClass::of("FDRE"), CellClass::Reg);
        assert_eq!(CellClass::of("$dff"), CellClass::Reg);
        assert_eq!(CellClass::of("SRL16E"), CellClass::Reg);
        assert_eq!(CellClass::of("RAMB18E1"), CellClass::Other);
        // A node with no cell type is a port boundary, not a cell.
        assert_eq!(CellClass::of_opt(None), CellClass::Port);
        assert_eq!(CellClass::of_opt(Some("LUT6")), CellClass::Lut);
    }

    /// The generational win is in **routing**, not in the LUT.
    ///
    /// This replaces a test that asserted `lut_ps` falls monotonically from
    /// Series-7 to UltraScale to UltraScale+. That was an assumption, and
    /// measurement refutes it: Series-7 and UltraScale LUT arcs come out at
    /// ~152 vs ~151 ps. Vivado's own aggregate agrees — `barrel_w32` at 4 logic
    /// levels reports logic 0.522 ns on Series-7 and 0.730 ns on UltraScale.
    /// Asserting the old ordering would force `lut_ps` away from what Vivado
    /// actually reports, so the test now pins the thing that *is* true and
    /// load-bearing.
    #[test]
    fn newer_families_win_on_routing_not_on_logic() {
        let s7 = DelayModel::series7();
        let us = DelayModel::ultrascale();
        let usp = DelayModel::ultrascale_plus();
        // Routing improves by a lot, and monotonically.
        assert!(s7.net_base_ps > us.net_base_ps);
        assert!(us.net_base_ps >= usp.net_base_ps);
        // Carry improves by a lot.
        assert!(s7.carry_ps > us.carry_ps);
        // Logic does NOT track the process generation — 7-series and UltraScale
        // LUTs are within a few ps of each other.
        assert!(
            (s7.lut_ps - us.lut_ps).abs() < 25.0,
            "measured LUT delay is ~equal on series7/ultrascale ({} vs {})",
            s7.lut_ps,
            us.lut_ps
        );
        assert_eq!(DelayModel::default(), DelayModel::series7());
    }

    #[test]
    fn for_target_selects_by_mode_and_family() {
        assert_eq!(
            DelayModel::for_target("xilinx", Some("xcup")),
            DelayModel::ultrascale_plus()
        );
        assert_eq!(
            DelayModel::for_target("xilinx", Some("XCU")),
            DelayModel::ultrascale()
        );
        assert_eq!(
            DelayModel::for_target("xilinx", Some("xc7")),
            DelayModel::series7()
        );
        assert_eq!(
            DelayModel::for_target("xilinx", None),
            DelayModel::series7()
        );
        assert_eq!(DelayModel::for_target("ice40", None), DelayModel::ice40());
        assert_eq!(DelayModel::for_target("gates", None), DelayModel::generic());
        assert_eq!(DelayModel::for_target("rtl", None), DelayModel::generic());
    }

    #[test]
    fn speed_grade_scaling_is_per_family_and_measured() {
        // The whole point of keying on the profile: a -3 grade buys far more on
        // Series-7 than on UltraScale+, so a single global factor cannot be
        // right for both. Values come from Vivado's own -1-vs-N measurements.
        let s7 = DelayProfile::Series7.speed_grade_factor(Some("-3"));
        let usp = DelayProfile::UltraScalePlus.speed_grade_factor(Some("-3"));
        assert!(
            s7 < usp,
            "series7 should gain more from -3 than ultrascale+ ({s7} vs {usp})"
        );

        // -1 is the baseline every preset is characterized at, so it must not
        // scale at all — for any family, however it is spelled.
        for profile in [
            DelayProfile::Series7,
            DelayProfile::UltraScale,
            DelayProfile::UltraScalePlus,
            DelayProfile::Ice40,
            DelayProfile::Generic,
        ] {
            assert_eq!(profile.speed_grade_factor(Some("-1")), 1.0);
            assert_eq!(profile.speed_grade_factor(None), 1.0);
            // A faster grade is always faster, and -3 beats -2.
            let g2 = profile.speed_grade_factor(Some("-2"));
            let g3 = profile.speed_grade_factor(Some("-3"));
            assert!(g3 < g2 && g2 < 1.0, "{profile:?}: {g3} < {g2} < 1");
        }
    }

    #[test]
    fn profile_names_match_the_wire_format_the_client_sends() {
        // These strings are the `profile` field of a /timing request and the
        // values in the frontend's PROFILE_OPTIONS; a typo here silently
        // downgrades a caller to Series-7 rather than failing.
        for (name, profile) in [
            ("series7", DelayProfile::Series7),
            ("ultrascale", DelayProfile::UltraScale),
            ("ultrascale_plus", DelayProfile::UltraScalePlus),
            ("ice40", DelayProfile::Ice40),
            ("ecp5", DelayProfile::Ecp5),
            ("generic", DelayProfile::Generic),
        ] {
            assert_eq!(DelayProfile::from_name(Some(name)), profile);
            assert_eq!(
                DelayModel::for_target("xilinx", None),
                DelayModel::series7()
            );
        }
        // Unknown / absent names fall back to the historical default.
        assert_eq!(DelayProfile::from_name(None), DelayProfile::Series7);
        assert_eq!(
            DelayProfile::from_name(Some("bogus")),
            DelayProfile::Series7
        );
    }

    #[test]
    fn scaled_multiplies_all_terms_and_clamps() {
        let base = DelayModel::series7();
        let faster = base.scaled(0.8);
        assert!((faster.lut_ps - base.lut_ps * 0.8).abs() < 1e-9);
        assert!((faster.net_base_ps - base.net_base_ps * 0.8).abs() < 1e-9);
        // absurd factors are clamped rather than producing zero/huge delays
        assert_eq!(base.scaled(0.0), base.scaled(0.1));
        assert_eq!(base.scaled(1000.0), base.scaled(10.0));
    }
}
