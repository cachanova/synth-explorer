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

/**
 * Keep a bounded synthesis queue aligned with the editor's current input.
 * A queued request becomes obsolete as soon as the input changes again; the
 * normal idle debounce decides whether the replacement should be enqueued.
 */
export function retainQueuedSynthesis(
  queued: SynthesisInput | null,
  currentKey: string,
): SynthesisInput | null {
  return queued?.key === currentKey ? queued : null
}

/** The running request already covers a reverted input, so no follow-up is needed. */
export function queuedSynthesisForRequest(
  runningKey: string | null,
  requested: SynthesisInput,
): SynthesisInput | null {
  return runningKey === requested.key ? null : requested
}

export function analysisNeedsRefresh(
  currentKey: string,
  designKey: string | null,
  runningKey: string | null,
): boolean {
  return designKey !== currentKey || (runningKey != null && runningKey !== currentKey)
}
