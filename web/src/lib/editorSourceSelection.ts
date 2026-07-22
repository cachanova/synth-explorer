import type { EditorState } from '@codemirror/state'

const SOURCE_STATEMENT_SCAN_CAP = 4096

/** Convert CodeMirror's half-open character selection to 1-based inclusive coordinates. */
export function selectedSourceRange(state: EditorState): {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  fallbackStartColumn?: number
  fallbackEndColumn?: number
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
  const collapsed = selection.from === selection.to
  const statementBounds = collapsed && start.length <= SOURCE_STATEMENT_SCAN_CAP
    ? semicolonStatementBounds(start.text, selection.from - start.from)
    : null
  return {
    startLine: start.number,
    startColumn: selection.from - start.from + 1,
    endLine: end.number,
    endColumn: inclusiveEndPosition - end.from + 1,
    ...(statementBounds == null
      ? {}
      : {
          fallbackStartColumn: statementBounds.startColumn,
          fallbackEndColumn: statementBounds.endColumn,
        }),
  }
}

function semicolonStatementBounds(
  line: string,
  caretOffset: number,
): { startColumn: number; endColumn: number } | null {
  let previous = -1
  let next = -1
  let inBlockComment = false
  let inString = false
  let inEscapedIdentifier = false
  let stringEscape = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const following = line[index + 1]
    if (inBlockComment) {
      if (char === '*' && following === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }
    if (inString) {
      if (stringEscape) {
        stringEscape = false
      } else if (char === '\\') {
        stringEscape = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (inEscapedIdentifier) {
      if (/\s/.test(char)) inEscapedIdentifier = false
      else continue
    }
    if (char === '/' && following === '/') break
    if (char === '/' && following === '*') {
      inBlockComment = true
      index += 1
      continue
    }
    if (char === '*' && following === '/') return null
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '\\') {
      inEscapedIdentifier = true
      continue
    }
    if (char !== ';') continue
    if (index < caretOffset) previous = index
    else if (next < 0) next = index
  }
  return {
    startColumn: previous < 0 ? 1 : previous + 2,
    endColumn: next < 0 ? Math.max(1, line.length) : next + 1,
  }
}
