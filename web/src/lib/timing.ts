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
