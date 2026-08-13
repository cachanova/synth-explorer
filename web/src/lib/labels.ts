import type { Mode, SynthTool, XilinxFamily } from '../types'

export const PLATFORM_LABELS: { value: Mode; label: string }[] = [
  { value: 'rtl', label: 'RTL (word-level)' },
  { value: 'gates', label: 'Generic gates' },
  { value: 'lut4', label: 'Generic LUT4 metric' },
  { value: 'lut6', label: 'Generic LUT6 metric' },
  { value: 'ice40', label: 'iCE40' },
  { value: 'ecp5', label: 'ECP5' },
  { value: 'xilinx', label: 'Xilinx' },
]

export const SYNTH_TOOL_LABELS: { value: SynthTool; label: string }[] = [
  { value: 'yosys', label: 'Yosys' },
  { value: 'vivado', label: 'Vivado' },
]

// Xilinx target families (synth_xilinx -family). Determines carry (CARRY4 vs
// CARRY8), BRAM, and DSP primitives, so it makes the netlist match the vendor
// flow for that device. Default xc7 matches yosys's own default.
export const XILINX_FAMILY_LABELS: { value: XilinxFamily; label: string }[] = [
  { value: 'xc7', label: 'Series 7' },
  { value: 'xcup', label: 'UltraScale+' },
  { value: 'xcu', label: 'UltraScale' },
  { value: 'xc6s', label: 'Spartan-6' },
  { value: 'xc6v', label: 'Virtex-6' },
]
