import type { Mode, SynthTool } from '../types'
import { hasFlag, setFlagValue, stripFlags, toggleFlag } from './synthFlags'

interface BaseFlagDef {
  flag: string
  label: string
  description: string
  /** caution shown in the menu */
  warn?: string
  /** applied automatically on switching to this mode; user-removable */
  defaultOn?: boolean
  /** shown in the menu: why this flag is on by default */
  defaultReason?: string
}

interface BooleanFlagDef extends BaseFlagDef {
  value?: undefined
}

interface IntegerFlagDef extends BaseFlagDef {
  value: 'int'
  defaultValue: string
  min?: number
  max?: number
}

interface SelectFlagDef extends BaseFlagDef {
  value: 'select'
  defaultValue: string
  choices: readonly string[]
}

export type FlagDef = BooleanFlagDef | IntegerFlagDef | SelectFlagDef

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
  {
    flag: '-narrowcarry',
    label: 'LUT-map narrow arithmetic \u2264 N bits',
    description:
      'App flag (not a yosys option): arithmetic with results up to N bits is ' +
      'mapped to LUT logic instead of a carry chain; wider arithmetic keeps ' +
      'its chain.',
    value: 'int',
    defaultValue: '8',
    min: 1,
    max: 64,
    defaultOn: true,
    defaultReason:
      'Yosys otherwise commits every addition to CARRY4 no matter how small, ' +
      'and a tiny chain costs entry/exit levels while blocking logic ' +
      'optimization across it \u2014 a 3-bit add left a 4-level netlist where ' +
      "Vivado needs one LUT. With the default of 8 (where Vivado's own " +
      'synthesis stops using carry chains), netlist depth matches Vivado at ' +
      'median parity on the calibration corpus. Remove the flag to always ' +
      'use carry chains.',
  },
  { flag: '-nocarry', label: 'No carry chains', description: 'Adders/comparators in LUT logic instead of CARRY4.' },
  { flag: '-nodsp', label: 'No DSP', description: 'Multipliers in logic instead of DSP48.' },
  { flag: '-nobram', label: 'No block RAM', description: 'Memories in registers/logic instead of RAMB.', warn: 'Can exhaust resources on large memories.' },
  { flag: '-nolutram', label: 'No distributed RAM', description: 'No LUT-based RAM.', warn: 'Can exhaust resources on large memories.' },
  { flag: '-nosrl', label: 'No shift-register LUTs', description: 'Shift registers as flip-flop chains.' },
  {
    flag: '-nowidelut',
    label: 'No wide-LUT muxes',
    description: 'No MUXF7/MUXF8 mux resources.',
    defaultOn: true,
    defaultReason:
      'Measured on the calibration corpus, wide-LUT mapping stacked MUXF7/8 ' +
      'levels on top of the LUT tree: netlists came out 1.5\u20132\u00d7 deeper than ' +
      "Vivado's, with more cells. Without it, depth matches Vivado's synthesis " +
      'at median parity. Remove the flag to get the wide-LUT mapping back.',
  },
  {
    flag: '-noiopad',
    label: 'No I/O buffers',
    description: 'Skip IBUF/OBUF insertion for a cleaner netlist.',
    defaultOn: true,
    defaultReason:
      'The explorer analyzes the fabric logic; pad buffers add IBUF/OBUF ' +
      'cells on every port that obscure the netlist without changing it.',
  },
  { flag: '-noclkbuf', label: 'No clock buffers', description: 'Skip BUFG clock-buffer insertion.' },
  { flag: '-uram', label: 'Infer UltraRAM', description: 'URAM288 for large memories (UltraScale+ only).' },
  { flag: '-dff', label: 'FF-aware mapping', description: 'Run ABC with -dff (flip-flop-aware).' },
  { flag: '-retime', label: 'Register retiming', description: 'Move registers across logic to balance path depth.' },
  { flag: '-widemux', label: 'Infer hard muxes ≥ N', description: 'Use MUXF7/8 for muxes at or above N inputs (min 2).', value: 'int', defaultValue: '5', min: 2 },
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
  {
    flag: '-noiopad',
    label: 'No I/O buffers',
    description: 'Do not insert I/O buffers.',
    defaultOn: true,
    defaultReason:
      'The explorer analyzes the fabric logic; pad buffers add cells on ' +
      'every port that obscure the netlist without changing it.',
  },
  { flag: '-dff', label: 'FF-aware mapping', description: 'Run ABC with -dff (flip-flop-aware).' },
  { flag: '-abc9', label: 'ABC9 flow', description: 'Newer ABC9 area/delay mapping.' },
  { flag: '-asyncprld', label: 'Async PRLD ALDFF', description: 'Async PRLD mode for ALDFF (experimental).' },
]

const VIVADO: FlagDef[] = [
  {
    flag: '-directive',
    label: 'Synthesis directive',
    description: 'Select a built-in optimization strategy.',
    value: 'select',
    defaultValue: 'default',
    choices: [
      'default',
      'RuntimeOptimized',
      'AreaOptimized_high',
      'AreaOptimized_medium',
      'AlternateRoutability',
      'AreaMapLargeShiftRegToBRAM',
      'AreaMultThresholdDSP',
      'FewerCarryChains',
      'PerformanceOptimized',
      'LogicCompaction',
      'PowerOptimized_high',
      'PowerOptimized_medium',
    ],
  },
  {
    flag: '-fsm_extraction',
    label: 'FSM extraction',
    description: 'Choose finite-state-machine extraction and encoding.',
    value: 'select',
    defaultValue: 'auto',
    choices: ['auto', 'off', 'one_hot', 'sequential', 'johnson', 'gray', 'user_encoding'],
  },
  {
    flag: '-resource_sharing',
    label: 'Resource sharing',
    description: 'Control sharing of compatible arithmetic operators.',
    value: 'select',
    defaultValue: 'auto',
    choices: ['auto', 'on', 'off'],
  },
  {
    flag: '-cascade_dsp',
    label: 'DSP cascading',
    description: 'Control DSP cascade inference for arithmetic structures.',
    value: 'select',
    defaultValue: 'auto',
    choices: ['auto', 'tree', 'force'],
  },
  {
    flag: '-global_retiming',
    label: 'Global retiming',
    description: 'Move registers across combinational logic to improve timing.',
    value: 'select',
    defaultValue: 'auto',
    choices: ['auto', 'on', 'off'],
  },
  {
    flag: '-gated_clock_conversion',
    label: 'Gated-clock conversion',
    description: 'Convert supported gated clocks to clock-enable logic.',
    value: 'select',
    defaultValue: 'off',
    choices: ['off', 'on', 'auto'],
    warn: 'Effective conversion can depend on clock constraints and HDL attributes.',
  },
  {
    flag: '-srl_style',
    label: 'SRL style',
    description: 'Choose how registers surround inferred shift-register LUTs.',
    value: 'select',
    defaultValue: 'srl',
    choices: ['register', 'srl', 'srl_reg', 'reg_srl', 'reg_srl_reg'],
  },
  {
    flag: '-shreg_min_size',
    label: 'Minimum SRL length',
    description: 'Minimum shift-register length eligible for SRL inference.',
    value: 'int',
    defaultValue: '3',
    min: 1,
  },
  {
    flag: '-max_bram',
    label: 'BRAM limit',
    description: 'Limit block RAM use; 0 keeps inferred memories out of BRAM.',
    value: 'int',
    defaultValue: '0',
    min: -1,
  },
  {
    flag: '-max_uram',
    label: 'UltraRAM limit',
    description: 'Limit UltraRAM use; 0 keeps inferred memories out of UltraRAM.',
    value: 'int',
    defaultValue: '0',
    min: -1,
  },
  {
    flag: '-max_dsp',
    label: 'DSP limit',
    description: 'Limit DSP use; 0 maps arithmetic without DSP blocks.',
    value: 'int',
    defaultValue: '0',
    min: -1,
  },
  {
    flag: '-no_lc',
    label: 'No LUT combining',
    description: 'Disable LUT combining during synthesis.',
  },
  {
    flag: '-lut_cascade',
    label: 'LUT cascading',
    description: 'Allow LUT cascade optimization.',
  },
  {
    flag: '-keep_equivalent_registers',
    label: 'Keep equivalent registers',
    description: 'Preserve registers with equivalent behavior instead of merging them.',
  },
  {
    flag: '-no_srlextract',
    label: 'No SRL extraction',
    description: 'Keep shift registers as flip-flops instead of SRL primitives.',
  },
  {
    flag: '-no_timing_driven',
    label: 'No timing-driven synthesis',
    description: 'Disable timing-driven optimizations.',
    warn: 'Usually produces worse timing results.',
  },
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

export function flagsForTool(tool: SynthTool, mode: Mode): FlagDef[] {
  return tool === 'vivado' ? VIVADO : flagsForMode(mode)
}

/** `-family` is value-taking and Xilinx-only; the menu never lists it (the Target
 *  dropdown owns it), but mode-switching must still be able to strip it. */
// Derived from the registry so a newly added value-taking flag can never be
// silently stripped without its value token on a mode change. `-family` is the
// one value flag living outside the registry (it is the Target dropdown).
const VALUE_FLAGS = new Set([
  '-family',
  ...Object.values(FLAG_REGISTRY).flatMap((defs) =>
    defs.filter((def) => def.value).map((def) => def.flag),
  ),
])

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

/** Apply the destination mode's defaults after removing incompatible flags.
 *  Defaults are ordinary registry flags marked `defaultOn` — they land in the
 *  visible flags string, so the user can see and remove them (nothing is
 *  injected server-side). */
export function flagsForModeChange(flags: string, mode: Mode): string {
  let next = stripInvalidFlags(flags, mode)
  for (const definition of flagsForMode(mode)) {
    if (!definition.defaultOn || hasFlag(next, definition.flag)) continue
    next = definition.value
      ? setFlagValue(next, definition.flag, definition.defaultValue)
      : toggleFlag(next, definition.flag, true)
  }
  return next
}
