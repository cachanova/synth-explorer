import type { DesignFile, Mode, SynthesizeRequest, SynthTool } from '../types'
import { buildSynthesizeRequest } from './synthesize'

export interface SourceSelection {
  file: string
  startLine: number
  endLine: number
}

export interface SourceProbeDebouncer {
  schedule(selection: SourceSelection): void
  cancel(): void
}

export function createSourceProbeDebouncer(
  onProbe: (selection: SourceSelection) => void,
  delayMs = 250,
): SourceProbeDebouncer {
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    schedule(selection) {
      cancel()
      timer = setTimeout(() => {
        timer = null
        onProbe(selection)
      }, delayMs)
    },
    cancel,
  }
}

export interface SynthesisInput {
  request: SynthesizeRequest
  key: string
  revision: number
}

export type QueuedSynthesis = SynthesisInput

// This identity is exact but O(total source bytes). Callers deliberately
// materialize it only for a manual synthesis, never per edit.
export function synthesisInput(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
  revision = 0,
  tool: SynthTool = 'yosys',
  target = '',
): SynthesisInput {
  const request = buildSynthesizeRequest(files, top, mode, extraArgs, tool, target)
  return { request, key: JSON.stringify(request), revision }
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
 * A queued request becomes obsolete as soon as the input changes again.
 */
export function retainQueuedSynthesis(
  queued: QueuedSynthesis | null,
  currentRevision: number,
): QueuedSynthesis | null {
  return queued?.revision === currentRevision ? queued : null
}

/** The running request already covers a reverted input, so no follow-up is needed. */
export function queuedSynthesisForRequest(
  runningKey: string | null,
  requested: SynthesisInput,
): QueuedSynthesis | null {
  if (runningKey === requested.key) return null
  return requested
}
