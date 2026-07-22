import type { DesignFile, Mode, SynthesizeRequest, SynthTool } from '../types'
import { buildSynthesizeRequest, type VivadoRequestTarget } from './synthesize'

export interface SourceSelection {
  file: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  fallbackStartColumn?: number
  fallbackEndColumn?: number
}

export function boundedSourceSelection(
  selection: SourceSelection,
  maxLines: number,
): {
  startLine: number
  startColumn?: number
  endLine: number
  endColumn?: number
  truncated: boolean
} {
  const endLine = Math.min(selection.endLine, selection.startLine + maxLines - 1)
  const truncated = endLine !== selection.endLine
  return {
    startLine: selection.startLine,
    startColumn: truncated ? undefined : selection.startColumn,
    endLine,
    endColumn: truncated ? undefined : selection.endColumn,
    truncated,
  }
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
  tool: SynthTool = 'yosys',
  vivado?: VivadoRequestTarget,
): SynthesisInput {
  const request = buildSynthesizeRequest(files, top, mode, extraArgs, tool, vivado)
  return { request, key: JSON.stringify(request), revision }
}

export function normalizeSourceSelection(
  file: string,
  startLine: number,
  endLine: number,
  startColumn = 1,
  endColumn = startColumn,
  fallbackStartColumn?: number,
  fallbackEndColumn?: number,
): SourceSelection {
  const first = { line: Math.max(1, startLine), column: Math.max(1, startColumn) }
  const last = { line: Math.max(1, endLine), column: Math.max(1, endColumn) }
  const ordered =
    first.line < last.line || (first.line === last.line && first.column <= last.column)
      ? [first, last]
      : [last, first]
  const fallbackColumns =
    fallbackStartColumn == null || fallbackEndColumn == null
      ? {}
      : { fallbackStartColumn, fallbackEndColumn }
  return {
    file,
    startLine: ordered[0].line,
    startColumn: ordered[0].column,
    endLine: ordered[1].line,
    endColumn: ordered[1].column,
    ...fallbackColumns,
  }
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
