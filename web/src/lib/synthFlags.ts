import type { XilinxFamily } from '../types'

// The synthesis-flags string (extra_args) is the single source of truth for what
// reaches yosys. The Target-family dropdown and the searchable flag menu are just
// editors of that string: they parse their state out of it and write tokens back
// in. These helpers do the token surgery.

const FAMILIES = new Set<XilinxFamily>(['xc7', 'xcup', 'xcu', 'xc6s', 'xc6v'])

/** yosys default for `synth_xilinx -family`; represented as "no -family token". */
export const DEFAULT_XILINX_FAMILY: XilinxFamily = 'xc7'

export function tokens(flags: string): string[] {
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

/** Set `-family`; the default (xc7) is written as *no* token to keep flags lean. */
export function setFamily(flags: string, family: XilinxFamily): string {
  const t = setFlagValue(flags, '-family', family === DEFAULT_XILINX_FAMILY ? '' : family)
  return t
}

// ---- generic flag helpers (boolean and value-taking) ----

/** Is a boolean flag (e.g. `-nocarry`) present? */
export function hasFlag(flags: string, flag: string): boolean {
  return tokens(flags).includes(flag)
}

/** Add or remove a boolean flag, never duplicating it. */
export function toggleFlag(flags: string, flag: string, on: boolean): string {
  const t = tokens(flags).filter((tok) => tok !== flag)
  if (on) t.push(flag)
  return t.join(' ')
}

/** The value token following a value-taking flag (e.g. `-widemux 5` → "5"), or null. */
export function getFlagValue(flags: string, flag: string): string | null {
  const t = tokens(flags)
  const i = t.indexOf(flag)
  return i >= 0 && i + 1 < t.length ? t[i + 1] : null
}

/** Set a value-taking flag's value; an empty value removes the flag entirely. */
export function setFlagValue(flags: string, flag: string, value: string): string {
  const t = withoutFlagValue(tokens(flags), flag)
  if (value !== '') t.push(flag, value)
  return t.join(' ')
}

/** Drop a `<flag> <value>` pair from a token list. */
function withoutFlagValue(t: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < t.length; i++) {
    if (t[i] === flag) {
      i++ // also skip its value
      continue
    }
    out.push(t[i])
  }
  return out
}

/** Remove the given flags from the string. Value-taking flags also drop the
 *  value token that follows them. Used to clear platform-specific flags on a platform
 *  switch. Unknown/free-form tokens are left untouched. */
export function stripFlags(
  flags: string,
  spec: { flag: string; takesValue?: boolean }[],
): string {
  let out = flags
  for (const { flag, takesValue } of spec) {
    out = takesValue ? setFlagValue(out, flag, '') : toggleFlag(out, flag, false)
  }
  return out
}
