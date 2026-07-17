import type { DelayProfile } from '../types'

const ESTIMATE_BASE =
  'An estimate, not a measurement. It sums per-cell delays with an estimated routing delay along the critical path of the synthesis netlist, before placement or routing. Use it to compare paths and weigh design choices — the ordering is far more trustworthy than the absolute number.'

/** Keep the signoff recommendation honest for the technology being estimated. */
export function estimatedTimingCaveat(profile: DelayProfile): string {
  switch (profile) {
    case 'series7':
    case 'ultrascale':
    case 'ultrascale_plus':
      return `${ESTIMATE_BASE} For figures closer to implementation, run Vivado locally and use its timing report for signoff.`
    case 'ice40':
      return `${ESTIMATE_BASE} Use nextpnr and icetime for signoff-adjacent timing.`
    case 'ecp5':
      return `${ESTIMATE_BASE} Use nextpnr and its target-family timing reports for signoff-adjacent timing.`
    case 'sky130hd':
    case 'gf180mcu':
    case 'asap7':
      return `${ESTIMATE_BASE} Use OpenSTA or OpenROAD with the target library and physical constraints for signoff-adjacent timing.`
    case 'generic':
      return ESTIMATE_BASE
  }
}

// Implied maximum clock frequency (MHz) for a worst-case path delay in
// nanoseconds. Fmax = 1 / delay; ns → MHz is a direct reciprocal (1e3 ps? no:
// 1 ns period = 1 GHz = 1000 MHz), so MHz = 1000 / delay_ns.
export function fmaxMhz(delayNs: number): number {
  return 1000 / delayNs
}
