//! Rough pre-place-and-route timing estimate.
//!
//! This mirrors how a vendor tool (e.g. Vivado) reports *post-synthesis*
//! timing: it sums characterized-ish cell delays with a **fanout-based** net
//! delay estimate along the critical logic path. There is no placement or
//! routing, so the interconnect term is estimated purely from net fanout — the
//! same reason a vendor's post-synth numbers are labelled "estimated".
//!
//! The defaults are Series-7 (-1 speed grade) ballpark figures in picoseconds.
//! Every coefficient is meant to be *calibrated* against a real vendor timing
//! report; the struct is deliberately a flat bag of tunable numbers so a future
//! request can override it. This is NOT timing closure.

/// Tunable delay coefficients (picoseconds). See module docs.
#[derive(Debug, Clone, Copy, PartialEq)]
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
        Self {
            lut_ps: 100.0,
            carry_ps: 60.0,
            wide_mux_ps: 90.0,
            cell_ps: 130.0,
            ff_clk_to_q_ps: 400.0,
            ff_setup_ps: 60.0,
            net_base_ps: 200.0,
            net_per_fanout_ps: 40.0,
        }
    }
}

impl DelayModel {
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

    /// Launch delay at a path startpoint: a register contributes clock-to-Q, a
    /// top-level input contributes nothing (arrival time zero).
    pub fn launch_ps(&self, sequential: bool) -> f64 {
        if sequential { self.ff_clk_to_q_ps } else { 0.0 }
    }
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
}
