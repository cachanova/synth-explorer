import type { EditorState } from '@codemirror/state'

/** Convert CodeMirror's half-open character selection to 1-based inclusive coordinates. */
export function selectedSourceRange(state: EditorState): {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
} {
  const selection = state.selection.main
  const start = state.doc.lineAt(selection.from)
  const lineAtExclusiveEnd = state.doc.lineAt(selection.to)
  const endsAtNextLineStart =
    selection.from !== selection.to &&
    lineAtExclusiveEnd.number > 1 &&
    selection.to === lineAtExclusiveEnd.from
  const end = endsAtNextLineStart
    ? state.doc.line(lineAtExclusiveEnd.number - 1)
    : state.doc.lineAt(
        selection.from === selection.to
          ? selection.to
          : Math.max(selection.from, selection.to - 1),
      )
  const inclusiveEndPosition = endsAtNextLineStart
    ? Math.max(end.from, end.to - 1)
    : selection.from === selection.to
      ? selection.to
      : Math.max(selection.from, selection.to - 1)
  return {
    startLine: start.number,
    startColumn: selection.from - start.from + 1,
    endLine: end.number,
    endColumn: inclusiveEndPosition - end.from + 1,
  }
}
