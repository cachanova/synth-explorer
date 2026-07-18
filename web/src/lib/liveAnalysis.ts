import type { DesignFile, Mode, SynthesizeRequest } from '../types'
import { buildSynthesizeRequest } from './synthesize'

export const AUTO_SYNTHESIS_DELAY_MS = 250

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
  // Local worker queries are cheap; retain only a short coalescing window so a
  // drag does not trigger repeated ELK layouts while clicks still feel direct.
  delayMs = 50,
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
// materialize it only when synthesis is requested, never per keystroke.
export function synthesisInput(
  files: DesignFile[],
  top: string,
  mode: Mode,
  extraArgs: string,
  revision = 0,
): SynthesisInput {
  const request = buildSynthesizeRequest(files, top, mode, extraArgs)
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
