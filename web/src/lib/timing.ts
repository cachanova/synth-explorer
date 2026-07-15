import type { DelayBreakdown } from '../types'

export const ESTIMATED_TIMING_CAVEAT =
  'An estimate, not a measurement. It sums per-cell delays with an estimated routing delay along the critical path of the synthesis netlist, before placement or routing. Use it to compare paths and weigh design choices — the ordering is far more trustworthy than the absolute number. For figures closer to Vivado, use the Vivado backend; for signoff, use Vivado\'s own timing report.'

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

export const VIVADO_TIMING_CAVEAT =
  "Measured by Vivado's own report_timing on the netlist it synthesized, for the worst register-to-register path under a synthetic 10 ns reference clock applied after synthesis. Like the estimate, it is a post-synthesis figure with estimated routing — Vivado's own estimate, not timing closure."

/**
 * The part of an estimate that is directly comparable to Vivado's Data Path
 * Delay. Vivado reports clk-to-Q + logic + route and folds FF setup into slack
 * instead, so the estimate's setup term has to come off before the two numbers
 * describe the same quantity. Returns null without a breakdown to subtract.
 */
export function dataPathEstimateNs(
  delayNs: number,
  breakdown: DelayBreakdown | undefined,
): number | null {
  if (!breakdown) return null
  return delayNs - breakdown.setup_ns
}

/**
 * How far the estimate lands from the measurement, as a percentage of the
 * measurement (positive = the estimate is pessimistic). Both arguments must
 * already be like-for-like — see dataPathEstimateNs.
 */
export function estimateErrorPct(
  estimateNs: number,
  measuredNs: number,
): number | null {
  if (!(measuredNs > 0)) return null
  return ((estimateNs - measuredNs) / measuredNs) * 100
}
