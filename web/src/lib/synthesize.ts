import type { DesignFile, Mode, SynthesizeRequest, SynthTool } from '../types'

export interface VivadoRequestTarget {
  name: string
  family: string
  speed: string
  version: string
}

export function buildSynthesizeRequest(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
  tool: SynthTool = 'yosys',
  vivado?: VivadoRequestTarget,
): SynthesizeRequest {
  return {
    files,
    top: top.trim() || undefined,
    tool: tool === 'vivado' ? 'vivado' : undefined,
    mode: tool === 'vivado' ? 'xilinx' : mode,
    target: tool === 'vivado' ? vivado?.name : undefined,
    vivado_family: tool === 'vivado' ? vivado?.family : undefined,
    vivado_speed: tool === 'vivado' ? vivado?.speed : undefined,
    vivado_version: tool === 'vivado' ? vivado?.version : undefined,
    // The flags string is the single source of truth for the selected tool.
    extra_args: extraArgs.trim() || undefined,
  }
}
