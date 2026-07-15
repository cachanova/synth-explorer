import type { DesignFile, Mode, SynthesizeRequest, SynthTool } from '../types'

export function buildSynthesizeRequest(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
  tool: SynthTool = 'yosys',
  target = '',
): SynthesizeRequest {
  return {
    files,
    top: top.trim() || undefined,
    tool,
    mode,
    target: tool === 'vivado' ? target : undefined,
    // The flags string is the single source of truth for what reaches the
    // selected synthesis pass. Tool-specific controls edit this string.
    extra_args: extraArgs.trim() || undefined,
  }
}
