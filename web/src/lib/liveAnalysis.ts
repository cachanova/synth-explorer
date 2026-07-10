import type { DesignFile, Mode, SynthesizeRequest } from '../types'

export interface SourceSelection {
  file: string
  startLine: number
  endLine: number
}

export interface SynthesisInput {
  request: SynthesizeRequest
  key: string
}

export function synthesisInput(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
): SynthesisInput {
  const request = {
    files,
    top: top.trim() || undefined,
    mode,
    extra_args: extraArgs.trim() || undefined,
  }
  return { request, key: JSON.stringify(request) }
}

export function normalizeSourceSelection(
  file: string,
  startLine: number,
  endLine: number,
): SourceSelection {
  const start = Math.max(1, Math.min(startLine, endLine))
  const end = Math.max(start, Math.max(startLine, endLine))
  return { file, startLine: start, endLine: end }
}
