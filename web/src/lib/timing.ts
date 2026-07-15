export const ESTIMATED_TIMING_CAVEAT =
  'Estimated worst-case combinational delay along the critical path. The Xilinx presets are calibrated against Vivado 2026.1 post-synthesis timing (~6% mean error on an adder/mux sweep); Lattice/generic presets are not vendor-calibrated. It is a pre-place-and-route figure, not timing closure — a relative guide, not a signoff number.'

// Implied maximum clock frequency (MHz) for a worst-case path delay in
// nanoseconds. Fmax = 1 / delay; ns → MHz is a direct reciprocal (1e3 ps? no:
// 1 ns period = 1 GHz = 1000 MHz), so MHz = 1000 / delay_ns.
export function fmaxMhz(delayNs: number): number {
  return 1000 / delayNs
}

// Setup slack (ns) against a target clock: the target period minus the
// estimated path delay. Positive = the estimate meets the clock; negative =
// it fails by that much. Like the delay itself, this is a rough pre-route
// figure, not a signoff slack.
export function slackNs(delayNs: number, targetMhz: number): number {
  return 1000 / targetMhz - delayNs
}
