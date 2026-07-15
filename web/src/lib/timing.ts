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

// Deliberately no estimate-vs-measured delta anywhere in the UI. The two
// figures do not describe the same path, and nothing in the response says
// whether they happen to: Vivado reports the worst REGISTER-TO-REGISTER path
// and excludes FF setup (folding it into slack), whereas the estimate takes the
// worst arrival over every combinational node — of any path class — and always
// adds a setup term, even when the path ends at an output port rather than a
// register. Subtracting setup would make the units agree while leaving the two
// numbers describing different circuits, which is a worse error than showing no
// delta: it would look precise. Present both, label each, and let the reader
// compare. A true like-for-like delta needs a register-to-register-restricted
// estimate from the server, which does not exist today.
export const VIVADO_TIMING_CAVEAT =
  "Measured by Vivado's own report_timing on the netlist it synthesized: the worst register-to-register path, under a synthetic 10 ns reference clock applied after synthesis. Read it alongside the estimate rather than subtracting one from the other — this figure covers register-to-register paths only and excludes FF setup (Vivado folds setup into slack), while the estimate takes the worst path of any class and includes setup. Like the estimate, it is a post-synthesis figure with estimated routing — Vivado's own estimate, not timing closure."
