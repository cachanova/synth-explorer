export const ESTIMATED_TIMING_CAVEAT =
  'Estimated worst-case combinational delay: ballpark cell delays plus a fanout-based routing estimate along the critical path. It is a rough pre-place-and-route figure, not vendor timing closure — treat it as a relative guide, not a signoff number.'

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
