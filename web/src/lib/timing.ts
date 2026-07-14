export const ESTIMATED_TIMING_CAVEAT =
  'Estimated worst-case combinational delay: ballpark cell delays plus a fanout-based routing estimate along the critical path. It is a rough pre-place-and-route figure, not vendor timing closure — treat it as a relative guide, not a signoff number.'

// Implied maximum clock frequency (MHz) for a worst-case path delay in
// nanoseconds. Fmax = 1 / delay; ns → MHz is a direct reciprocal (1e3 ps? no:
// 1 ns period = 1 GHz = 1000 MHz), so MHz = 1000 / delay_ns.
export function fmaxMhz(delayNs: number): number {
  return 1000 / delayNs
}
