//! Rough pre-place-and-route timing estimate.
//!
//! This mirrors how a vendor tool (e.g. Vivado) reports *post-synthesis*
//! timing: it sums characterized-ish cell delays with a **fanout-based** net
//! delay estimate along the critical logic path. There is no placement or
//! routing, so the interconnect term is estimated purely from net fanout — the
//! same reason a vendor's post-synth numbers are labelled "estimated".
//!
//! # Calibration basis: Vivado's estimator on *our own* netlists
//!
//! The Xilinx presets are fitted against Vivado 2026.1's post-synthesis
//! `report_timing` run on **the netlists this app produces** (Yosys
//! `synth_xilinx` with the shipped `-nowidelut` default, exported as EDIF and
//! imported into Vivado, out-of-context, -1 speed grade). Same netlist on both
//! sides, so the delay model is the only variable. Earlier fits compared our
//! model on the Yosys netlist against Vivado's model on *Vivado's own,
//! structurally different* netlist — an ill-posed target (two variables at
//! once) that forced coefficients to absorb a ~2x depth ratio; those scored
//! ~74% mean error, and physically true per-cell values scored *worse* (91.5%)
//! against it.
//!
//! Against the well-posed target (24-design corpus x 3 families, 56 scored
//! paths), these coefficients land at **15.6% mean / 10.7% median** absolute
//! error vs Vivado's data-path estimate: Series-7 12.9%/9.4%, UltraScale
//! 18.6%/15.8%, UltraScale+ 15.4%/11.5%. Individual paths can still be off by
//! 40-60% — the worst cases are designs where Vivado's estimator picks a
//! structurally different worst path than we do (e.g. `inferred_fifo_d16` on
//! Series-7: our depth-4 memory path vs its 1-level path).
//!
//! The cell terms are physical: Vivado's own per-cell charges along real paths
//! of our netlists (path tables / `get_speed_models`). Only the two net terms
//! are fitted numerically, per family (see `calibration/README.md` for the
//! method and its traps). One modelling compromise is documented per preset:
//! a single `carry_ps` cannot represent chain entry vs cascade, and the right
//! constant differs by family — Series-7 wants the amortized mean, UltraScale
//! and UltraScale+ want the near-free cascade arc.
//!
//! [`DelayModel::net_delay_to_ps`] treating any net into a carry chain as free is
//! **correct**, and measurement backs it: over the full corpus the median
//! Series-7 `LUT->CARRY` route is 0.000 (n=72) and `CARRY->CARRY` is 0.000
//! (n=494). It is bimodal — 22 of 72 sit at 0.650, in 2 of 6 designs — so a
//! narrow sample can badly misread it. Carry cascade routing is dedicated and
//! documented (UG474: "dedicated routing connects the carry chain up a column of
//! slices").
//!
//! The estimate is still pre-place-and-route: both we and Vivado are
//! *estimating* interconnect at this stage, so agreement with Vivado's
//! estimate is not agreement with routed silicon. Depth and delay ordering
//! remain more trustworthy than any individual path's picoseconds.
//!
//! The Lattice (iCE40/ECP5) and `generic` presets are NOT vendor-calibrated
//! (no Lattice tool available); they are scaled to the same picosecond scale.
//! Every coefficient is a flat, tunable number so a request can override any of
//! them. This is still a pre-place-and-route estimate, NOT timing closure.

use deepsize::DeepSizeOf;
use serde::{Deserialize, Serialize};

/// Which device family's characterization a set of coefficients came from.
///
/// Kept separate from [`DelayModel`] on purpose. `DelayModel` is a bag of
/// numbers the user may freely edit; the profile is the *identity* of the
/// silicon those numbers describe. Speed-grade scaling is a property of the
/// silicon — Series-7 gains far more from a -3 grade than UltraScale+ does — so
/// it has to key on this rather than on the coefficient values.
// Deliberately NOT Serialize/Deserialize. Nothing serializes a profile — the
// wire format is the `profile` *name* parsed by `from_name` — and serde's
// snake_case would render `UltraScalePlus` as "ultra_scale_plus", disagreeing
// with both `from_name` and the client's union type. Add explicit renames if a
// response ever needs to carry one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, DeepSizeOf)]
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
    /// identical designs (regenerate via `calibration/`; see its README). The spread is real:
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

/// Tunable delay coefficients (picoseconds). See module docs.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, DeepSizeOf)]
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
    /// Fixed interconnect estimate for every net.
    pub net_base_ps: f64,
    /// Added per sink on the net (fanout term).
    pub net_per_fanout_ps: f64,
}

impl Default for DelayModel {
    fn default() -> Self {
        Self::series7()
    }
}

impl DelayModel {
    /// Xilinx 7-series (28nm, xc7a35t -1). Cell terms are Vivado 2026.1's own
    /// per-cell charges along real paths of *our* netlists (EDIF import; see
    /// module docs): LUT 143 ps is the corpus-weighted mean arc (the common
    /// LUT6 arc is 124), CARRY4 192 ps amortizes chain entry (S→CO ~533) /
    /// cascade (CI→CO 117) / exit (CI→O ~330) at the corpus's chain lengths,
    /// FDRE C→Q is 456, and RAMD32 read ~315 sets `cell_ps`. The net base is
    /// fitted per family against the same measurement (the measured per-net
    /// median is 657 with per-design spread 413–947; the fit lands higher
    /// partly because our worst path may launch from an input while Vivado's
    /// always starts with a clk-to-Q); the fanout slope is the shared
    /// within-design regression over Vivado's per-net estimates.
    pub fn series7() -> Self {
        Self {
            lut_ps: 143.0,
            carry_ps: 192.0,
            wide_mux_ps: 250.0,
            cell_ps: 320.0,
            ff_clk_to_q_ps: 456.0,
            ff_setup_ps: 40.0,
            net_base_ps: 773.0,
            net_per_fanout_ps: 29.0,
        }
    }

    /// Xilinx UltraScale (20nm, xcku035 -1). Same basis as [`Self::series7`].
    /// Unlike Series-7, the amortized per-CARRY8 mean (~210 ps) badly misfits:
    /// Vivado's worst path enters a carry chain near its top bit because the
    /// CIN→CO7 cascade is nearly free, so `carry_ps` is anchored to that
    /// cascade arc (35 ps) and the entry cost is absorbed by the fitted net
    /// base. FDRE C→Q 140 and LUT 136 are Vivado's path-table charges; MUXF7
    /// ~110 from `get_speed_models`; RAMD32 scaled from the Series-7
    /// measurement (no US path data).
    pub fn ultrascale() -> Self {
        Self {
            lut_ps: 136.0,
            carry_ps: 35.0,
            wide_mux_ps: 110.0,
            cell_ps: 300.0,
            ff_clk_to_q_ps: 140.0,
            ff_setup_ps: 30.0,
            net_base_ps: 136.0,
            net_per_fanout_ps: 28.0,
        }
    }

    /// Xilinx UltraScale+ (16nm FinFET, xcku5p -1). Same basis as
    /// [`Self::ultrascale`], with cell anchors scaled by the per-arc
    /// UltraScale+/UltraScale ratios from `get_speed_models` (cascade 0.8x,
    /// FF C→Q 98 ps = the low speed-model variant, matching how Vivado charged
    /// the low variant on UltraScale paths; LUTs are *not* faster than
    /// UltraScale's). Net terms fitted; Vivado's unplaced route estimate here
    /// is tiny and often literally zero.
    pub fn ultrascale_plus() -> Self {
        Self {
            lut_ps: 146.0,
            carry_ps: 28.0,
            wide_mux_ps: 90.0,
            cell_ps: 200.0,
            ff_clk_to_q_ps: 98.0,
            ff_setup_ps: 25.0,
            net_base_ps: 51.0,
            net_per_fanout_ps: 20.0,
        }
    }

    /// Lattice iCE40 (40nm) — a small, comparatively slow fabric. NOT
    /// vendor-calibrated (no Lattice tool here); scaled slower than Series-7.
    pub fn ice40() -> Self {
        Self {
            lut_ps: 480.0,
            carry_ps: 90.0,
            wide_mux_ps: 480.0,
            cell_ps: 480.0,
            ff_clk_to_q_ps: 800.0,
            ff_setup_ps: 60.0,
            net_base_ps: 320.0,
            net_per_fanout_ps: 70.0,
        }
    }

    /// Lattice ECP5 (40nm). NOT vendor-calibrated; scaled from Series-7.
    pub fn ecp5() -> Self {
        Self {
            lut_ps: 420.0,
            carry_ps: 90.0,
            wide_mux_ps: 420.0,
            cell_ps: 420.0,
            ff_clk_to_q_ps: 650.0,
            ff_setup_ps: 55.0,
            net_base_ps: 280.0,
            net_per_fanout_ps: 60.0,
        }
    }

    /// Technology-neutral preset for the non-silicon modes (generic gates, LUT
    /// metric, RTL). These modes are not a real device, so the figure is purely
    /// notional — it exists to keep the relative depth-vs-delay signal sensible.
    pub fn generic() -> Self {
        Self {
            lut_ps: 300.0,
            carry_ps: 250.0,
            wide_mux_ps: 300.0,
            cell_ps: 320.0,
            ff_clk_to_q_ps: 500.0,
            ff_setup_ps: 40.0,
            net_base_ps: 200.0,
            net_per_fanout_ps: 50.0,
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

    /// Estimated interconnect delay for a net driving `fanout` sinks. The fanout
    /// term grows with log2(fanout) — high-fanout nets get buffered/replicated in
    /// real routing, so a linear model wildly overestimates them.
    pub fn net_delay_ps(&self, fanout: u32) -> f64 {
        self.net_base_ps + self.net_per_fanout_ps * f64::from(fanout.max(1)).log2()
    }

    /// Interconnect delay for an edge, given the sink cell. A connection *into*
    /// a carry chain (LUT→carry or carry→carry) is a dedicated/local, intra-slice
    /// route and is ~free; the carry propagation cost lives in the CARRY cell
    /// delay instead. Everything else (→LUT, →register) uses general routing.
    pub fn net_delay_to_ps(&self, sink_cell: Option<&str>, fanout: u32) -> f64 {
        if is_carry_sink(sink_cell) {
            0.0
        } else {
            self.net_delay_ps(fanout)
        }
    }

    /// Launch delay at a path startpoint: a register contributes clock-to-Q, a
    /// top-level input contributes nothing (arrival time zero).
    pub fn launch_ps(&self, sequential: bool) -> f64 {
        if sequential { self.ff_clk_to_q_ps } else { 0.0 }
    }
}

/// Whether a connection into `sink_cell` rides dedicated carry routing.
fn is_carry_sink(sink_cell: Option<&str>) -> bool {
    sink_cell.is_some_and(|cell| is_carry(&cell.to_ascii_uppercase()))
}

fn is_carry(upper: &str) -> bool {
    matches!(upper, "MUXCY" | "XORCY" | "SB_CARRY")
        || upper.starts_with("CARRY")
        || upper.starts_with("CCU2")
}

fn is_wide_mux(upper: &str) -> bool {
    upper.starts_with("MUXF") || matches!(upper, "PFUMX" | "L6MUX21")
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
        // net delay grows with fanout, and fanout 0 is treated as 1
        assert!(m.net_delay_ps(10) > m.net_delay_ps(1));
        assert_eq!(m.net_delay_ps(0), m.net_delay_ps(1));
        assert_eq!(m.launch_ps(true), m.ff_clk_to_q_ps);
        assert_eq!(m.launch_ps(false), 0.0);
    }

    #[test]
    fn net_into_a_carry_chain_is_dedicated() {
        let m = DelayModel::series7();
        // A connection into a carry cell (LUT->carry or carry->carry) rides
        // dedicated routing and is free; everything else uses general routing.
        assert_eq!(m.net_delay_to_ps(Some("CARRY4"), 4), 0.0);
        assert_eq!(m.net_delay_to_ps(Some("MUXCY"), 1), 0.0);
        assert_eq!(m.net_delay_to_ps(Some("LUT6"), 4), m.net_delay_ps(4));
        assert_eq!(m.net_delay_to_ps(Some("FDRE"), 1), m.net_delay_ps(1));
        assert_eq!(m.net_delay_to_ps(None, 2), m.net_delay_ps(2));
    }

    #[test]
    fn newer_process_presets_are_faster_end_to_end() {
        // Deliberately NOT asserted on `lut_ps`: LUT delay is *not* monotonic
        // across these families. Vivado's own characterized data has Series-7
        // LUT6 at 124 ps and UltraScale at ~152 ps — the newer, smaller process
        // has the slower LUT, and the win shows up in routing and registers
        // instead. The old test asserted monotonic lut_ps and only passed because
        // the coefficients were guesses; real values would have failed it.
        //
        // What does hold is the whole-fabric picture, which is what a preset is
        // for.
        assert!(DelayModel::series7().ff_clk_to_q_ps > DelayModel::ultrascale().ff_clk_to_q_ps);
        assert!(
            DelayModel::ultrascale().ff_clk_to_q_ps > DelayModel::ultrascale_plus().ff_clk_to_q_ps
        );
        assert!(DelayModel::series7().carry_ps > DelayModel::ultrascale().carry_ps);
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
            DelayProfile::Ecp5,
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
