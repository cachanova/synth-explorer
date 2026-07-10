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
    extra_args: extraArgs.trim() || undefined,
  }
}
