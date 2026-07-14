import type { DesignFile, Mode, SynthesizeRequest } from '../types'

export function buildSynthesizeRequest(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
): SynthesizeRequest {
  const vivado = mode === 'vivado'
  return {
    files,
    top: top.trim() || undefined,
    mode,
    // The flags string is the single source of truth for what reaches yosys —
    // the Xilinx family/retime controls edit it directly (see lib/synthFlags).
    extra_args: vivado ? undefined : extraArgs.trim() || undefined,
  }
}
