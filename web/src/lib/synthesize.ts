import type { DesignFile, Mode, SynthesizeRequest, XilinxFamily } from '../types'

export function buildSynthesizeRequest(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
  family: XilinxFamily = 'xc7',
  retime = false,
): SynthesizeRequest {
  const xilinx = mode === 'xilinx'
  return {
    files,
    top: top.trim() || undefined,
    mode,
    extra_args: extraArgs.trim() || undefined,
    // Only Xilinx mode uses these, so other modes keep an identical request
    // (and cache key) regardless of the selectors' values.
    family: xilinx ? family : undefined,
    retime: xilinx ? retime : undefined,
  }
}
