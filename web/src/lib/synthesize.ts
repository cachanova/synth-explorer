import type { DesignFile, Mode, SynthesizeRequest } from '../types'

export function buildSynthesizeRequest(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
): SynthesizeRequest {
  return {
    files,
    top: top.trim() || undefined,
    mode,
    // The flags string is the single source of truth for what reaches Yosys.
    extra_args: extraArgs.trim() || undefined,
  }
}
