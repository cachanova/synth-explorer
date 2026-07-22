import type { SourceSelectionResult } from '../types'
import { queryAnalysis } from './analysisClient'

export interface SelectionOptions {
  maxNodes: number
  hideControl: boolean
  hideConst: boolean
  groupVectors: boolean
  groupMemories: boolean
}

export function analyzeSourceInBrowser(
  _id: string,
  selection: { file: string; startLine: number; endLine: number },
  options: SelectionOptions,
  signal?: AbortSignal,
): Promise<SourceSelectionResult> {
  return abortable(
    queryAnalysis<SourceSelectionResult>('source', {
      file: selection.file,
      start_line: selection.startLine,
      end_line: selection.endLine,
      max_nodes: options.maxNodes,
      hide_control: options.hideControl,
      hide_const: options.hideConst,
      group_vectors: options.groupVectors,
      group_memories: options.groupMemories,
    }),
    signal,
  )
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}
