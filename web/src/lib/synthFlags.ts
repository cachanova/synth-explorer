import type { XilinxFamily } from '../types'

// The Xilinx target-family selector and retime toggle are just editors for the
// synthesis-flags string (extra_args): they parse their state out of it and
// write tokens back in. This keeps the flags box the single source of truth for
// what reaches yosys, while the controls stay a convenient front-end for the
// two most common Xilinx knobs.

const FAMILIES = new Set<XilinxFamily>(['xc7', 'xcup', 'xcu', 'xc6s', 'xc6v'])

/** yosys default for `synth_xilinx -family`; represented as "no -family token". */
export const DEFAULT_XILINX_FAMILY: XilinxFamily = 'xc7'

function tokens(flags: string): string[] {
  return flags.trim().split(/\s+/).filter(Boolean)
}

function isFamily(value: string | undefined): value is XilinxFamily {
  return value !== undefined && FAMILIES.has(value as XilinxFamily)
}

/** The `-family <val>` in a flags string, or the default when absent/invalid. */
export function parseFamily(flags: string): XilinxFamily {
  const t = tokens(flags)
  const i = t.indexOf('-family')
  return i >= 0 && isFamily(t[i + 1]) ? (t[i + 1] as XilinxFamily) : DEFAULT_XILINX_FAMILY
}

export function parseRetime(flags: string): boolean {
  return tokens(flags).includes('-retime')
}

/** Drop any existing `-family <val>` pair from a token list. */
function withoutFamily(t: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '-family') {
      i++ // also skip its value
      continue
    }
    out.push(t[i])
  }
  return out
}

/** Set `-family`; the default (xc7) is written as *no* token to keep flags lean. */
export function setFamily(flags: string, family: XilinxFamily): string {
  const t = withoutFamily(tokens(flags))
  if (family !== DEFAULT_XILINX_FAMILY) t.push('-family', family)
  return t.join(' ')
}

export function setRetime(flags: string, on: boolean): string {
  const t = tokens(flags).filter((tok) => tok !== '-retime')
  if (on) t.push('-retime')
  return t.join(' ')
}

/** Remove the Xilinx-only managed flags (used when leaving Xilinx mode, where
 *  `synth`/`synth_ice40`/… would reject `-family`/`-retime`). */
export function stripXilinxFlags(flags: string): string {
  return setRetime(setFamily(flags, DEFAULT_XILINX_FAMILY), false)
}
