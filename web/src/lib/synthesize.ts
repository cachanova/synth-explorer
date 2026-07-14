import type { DesignFile, Mode, SynthesizeRequest, XilinxFamily } from '../types'

export function buildSynthesizeRequest(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
  family: XilinxFamily = 'xc7',
): SynthesizeRequest {
  return {
    files,
    top: top.trim() || undefined,
    mode,
    extra_args: extraArgs.trim() || undefined,
    // Only Xilinx mode uses a family, so other modes keep an identical request
    // (and cache key) regardless of the selector's value.
    family: mode === 'xilinx' ? family : undefined,
  }
}
