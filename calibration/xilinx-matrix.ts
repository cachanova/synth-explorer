import { flagsForModeChange } from '../web/src/lib/synthesis/flagRegistry'
import { setFlagValue, stripFlags, toggleFlag } from '../web/src/lib/synthesis/synthFlags'
import { buildYosysScript, validateSynthesisRequest } from '../web/src/lib/synthesis/yosysScript'
import type { SynthesizeRequest, XilinxFamily } from '../web/src/types'

export const XILINX_CALIBRATION_VARIANTS = [
  'production',
  'native-carry',
  'wide-lut',
  'no-carry',
] as const

export type XilinxCalibrationVariant = typeof XILINX_CALIBRATION_VARIANTS[number]

export interface CalibrationRenderRequest {
  request: SynthesizeRequest
  family: XilinxFamily
  variant: string
  additionalArgs?: string[]
  writeEdif?: boolean
}

export function isXilinxCalibrationVariant(value: string): value is XilinxCalibrationVariant {
  return (XILINX_CALIBRATION_VARIANTS as readonly string[]).includes(value)
}

/** Build a calibration request from the application's visible defaults.
 * `-noclkbuf` is the sole calibration-only flag: it matches Vivado's
 * out-of-context boundary without changing the browser default. */
export function xilinxCalibrationFlags(
  family: XilinxFamily,
  variant: XilinxCalibrationVariant,
): string {
  let flags = flagsForModeChange('', 'xilinx')
  flags = setFlagValue(flags, '-family', family)
  flags = toggleFlag(flags, '-noclkbuf', true)
  switch (variant) {
    case 'production':
      return flags
    case 'native-carry':
      return stripFlags(flags, [{ flag: '-narrowcarry', takesValue: true }])
    case 'wide-lut':
      return toggleFlag(flags, '-nowidelut', false)
    case 'no-carry':
      flags = stripFlags(flags, [{ flag: '-narrowcarry', takesValue: true }])
      return toggleFlag(flags, '-nocarry', true)
  }
}

export function renderCalibrationScript(input: CalibrationRenderRequest): string {
  if (!isXilinxCalibrationVariant(input.variant)) {
    throw new Error(`unknown Xilinx calibration variant: ${input.variant}`)
  }
  const baseFlags = xilinxCalibrationFlags(input.family, input.variant)
  const request = {
    ...input.request,
    mode: 'xilinx' as const,
    extra_args: [baseFlags, ...(input.additionalArgs ?? [])].join(' ').trim(),
  }
  let script = buildYosysScript(validateSynthesisRequest(request), 'map')
  if (input.writeEdif) script += 'write_edif -pvector bra netlist.edif\n'
  return script
}
