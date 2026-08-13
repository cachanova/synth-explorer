import type { GraphRequest, SourceGraphRequest } from '../store'
import {
  boundedSourceSelection,
  type SourceSelection,
} from './liveAnalysis'

const MAX_SOURCE_LINES = 200

export function sourceGraphRequest(
  selection: SourceSelection,
  nonce: number,
): SourceGraphRequest {
  const bounded = boundedSourceSelection(selection, MAX_SOURCE_LINES)
  const { endLine } = bounded
  const lineLabel =
    selection.startLine === endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}–${endLine}`
  return {
    kind: 'source',
    file: selection.file,
    startLine: bounded.startLine,
    startColumn: bounded.startColumn,
    endLine,
    endColumn: bounded.endColumn,
    fallbackStartColumn: selection.fallbackStartColumn,
    fallbackEndColumn: selection.fallbackEndColumn,
    selectionTruncated: bounded.truncated,
    label: `${selection.file}:${lineLabel}`,
    highlight: [],
    nonce,
  }
}

export function graphRequestAfterSynthesis(
  request: GraphRequest | null,
  sourceSelection: SourceSelection,
  nonce: number,
): GraphRequest | null {
  return request?.kind === 'source'
    ? sourceGraphRequest(sourceSelection, nonce)
    : null
}
