import type { Mode } from '../types'
import { stripFlags, toggleFlag } from './synthFlags'

export interface FlagDef {
  flag: string
  label: string
  description: string
  /** value-taking flag (renders a number field, e.g. `-widemux 5`) */
  value?: 'int'
  /** caution shown in the menu */
  warn?: string
}

// Curated, per-mode synthesis flags. Every entry was validated against the
// production yosys (0.67) — several flags listed in older `help` output are
// rejected there, so this list is deliberately narrower than the full man page.
// The Xilinx `-family` flag is intentionally excluded: it is the separate Target
// dropdown.

const GENERIC: FlagDef[] = [
  { flag: '-noabc', label: 'Skip ABC', description: 'No ABC logic optimization or gate mapping (faster, less optimized).' },
  { flag: '-noalumacc', label: 'Keep arithmetic operators', description: 'Do not decompose $add/$sub/$mul into $alu/$macc.' },
  { flag: '-nofsm', label: 'No FSM extraction', description: 'Skip finite-state-machine optimization.' },
  { flag: '-noshare', label: 'No resource sharing', description: 'Skip SAT-based sharing of arithmetic operators.' },
  { flag: '-booth', label: 'Booth multipliers', description: 'Map $mul to Booth-encoded multipliers.' },
  { flag: '-hieropt', label: 'Hierarchical optimization', description: 'Optimize across module boundaries (useful without flatten).' },
]

const XILINX: FlagDef[] = [
  { flag: '-nocarry', label: 'No carry chains', description: 'Adders/comparators in LUT logic instead of CARRY4.' },
  { flag: '-nodsp', label: 'No DSP', description: 'Multipliers in logic instead of DSP48.' },
  { flag: '-nobram', label: 'No block RAM', description: 'Memories in registers/logic instead of RAMB.', warn: 'Can exhaust resources on large memories.' },
  { flag: '-nolutram', label: 'No distributed RAM', description: 'No LUT-based RAM.', warn: 'Can exhaust resources on large memories.' },
  { flag: '-nosrl', label: 'No shift-register LUTs', description: 'Shift registers as flip-flop chains.' },
  { flag: '-nowidelut', label: 'No wide-LUT muxes', description: 'No MUXF7/MUXF8 mux resources.' },
  { flag: '-noiopad', label: 'No I/O buffers', description: 'Skip IBUF/OBUF insertion for a cleaner netlist.' },
  { flag: '-noclkbuf', label: 'No clock buffers', description: 'Skip BUFG clock-buffer insertion.' },
  { flag: '-uram', label: 'Infer UltraRAM', description: 'URAM288 for large memories (UltraScale+ only).' },
  { flag: '-dff', label: 'FF-aware mapping', description: 'Run ABC with -dff (flip-flop-aware).' },
  { flag: '-retime', label: 'Register retiming', description: 'Move registers across logic to balance path depth.' },
  { flag: '-widemux', label: 'Infer hard muxes ≥ N', description: 'Use MUXF7/8 for muxes at or above N inputs (min 2).', value: 'int' },
  { flag: '-abc9', label: 'ABC9 flow', description: 'Newer ABC9 area/delay mapping (experimental).' },
]

const ICE40: FlagDef[] = [
  { flag: '-nocarry', label: 'No carry chains', description: 'No SB_CARRY cells.' },
  { flag: '-nobram', label: 'No block RAM', description: 'No SB_RAM40 cells.', warn: 'Can exhaust resources on large memories.' },
  { flag: '-nodffe', label: 'No DFF-with-enable', description: 'No SB_DFFE* cells.' },
  { flag: '-spram', label: 'Infer SPRAM', description: 'Use SB_SPRAM256KA for large memories (UltraPlus).' },
  { flag: '-dsp', label: 'Use DSP', description: 'Use UltraPlus DSP cells for large arithmetic.' },
  { flag: '-dff', label: 'FF-aware mapping', description: 'Run ABC with -dff (flip-flop-aware).' },
]

const ECP5: FlagDef[] = [
  { flag: '-noccu2', label: 'No carry chains', description: 'No CCU2 carry cells (adders in LUTs).' },
  { flag: '-nobram', label: 'No block RAM', description: 'Memories in logic instead of block RAM.', warn: 'Can exhaust resources on large memories.' },
  { flag: '-nolutram', label: 'No distributed RAM', description: 'No LUT-based RAM.', warn: 'Can exhaust resources on large memories.' },
  { flag: '-nowidelut', label: 'No wide-LUT muxes', description: 'No PFU muxes for wide LUTs.' },
  { flag: '-nodsp', label: 'No DSP', description: 'Multipliers in logic instead of DSP.' },
  { flag: '-noiopad', label: 'No I/O buffers', description: 'Do not insert I/O buffers.' },
  { flag: '-dff', label: 'FF-aware mapping', description: 'Run ABC with -dff (flip-flop-aware).' },
  { flag: '-abc9', label: 'ABC9 flow', description: 'Newer ABC9 area/delay mapping.' },
  { flag: '-asyncprld', label: 'Async PRLD ALDFF', description: 'Async PRLD mode for ALDFF (experimental).' },
]

export const FLAG_REGISTRY: Partial<Record<Mode, FlagDef[]>> = {
  gates: GENERIC,
  lut4: GENERIC,
  lut6: GENERIC,
  xilinx: XILINX,
  ice40: ICE40,
  ecp5: ECP5,
  // rtl (prep) has no useful toggle flags.
}

export function flagsForMode(mode: Mode): FlagDef[] {
  return FLAG_REGISTRY[mode] ?? []
}

/** `-family` is value-taking and Xilinx-only; the menu never lists it (the Target
 *  dropdown owns it), but mode-switching must still be able to strip it. */
const VALUE_FLAGS = new Set(['-family', '-widemux'])

function allKnownFlags(): string[] {
  const all = new Set<string>(['-family'])
  for (const defs of Object.values(FLAG_REGISTRY)) {
    for (const def of defs) all.add(def.flag)
  }
  return [...all]
}

/** Remove any *known* flag that isn't valid for `mode` (keeps free-form tokens),
 *  so switching modes never leaves a flag the new synth pass would reject. */
export function stripInvalidFlags(flags: string, mode: Mode): string {
  const valid = new Set(flagsForMode(mode).map((d) => d.flag))
  if (mode === 'xilinx') valid.add('-family')
  const toStrip = allKnownFlags()
    .filter((flag) => !valid.has(flag))
    .map((flag) => ({ flag, takesValue: VALUE_FLAGS.has(flag) }))
  return stripFlags(flags, toStrip)
}

/** Apply the destination mode's defaults after removing incompatible flags. */
export function flagsForModeChange(flags: string, mode: Mode): string {
  const stripped = stripInvalidFlags(flags, mode)
  const defaultsWithoutIoPads = flagsForMode(mode).some(
    (definition) => definition.flag === '-noiopad',
  )
  return defaultsWithoutIoPads
    ? toggleFlag(stripped, '-noiopad', true)
    : stripped
}
