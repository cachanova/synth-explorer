import type { Text } from '@codemirror/state'
import type { EditorHighlight } from '../store'

export type HighlightDecorationKind =
  | 'primary'
  | 'secondary'
  | 'contributing'

export interface HighlightDecoration {
  from: number
  to?: number
  kind: HighlightDecorationKind
}

export interface HighlightDecorationMapping {
  decorations: HighlightDecoration[]
  primaryPosition: number | null
}

function strongerHighlight(
  left: HighlightDecorationKind | undefined,
  right: HighlightDecorationKind,
): HighlightDecorationKind {
  const rank: Record<HighlightDecorationKind, number> = {
    contributing: 0,
    secondary: 1,
    primary: 2,
  }
  return left == null || rank[right] > rank[left] ? right : left
}

export function editorHighlightDecorations(
  doc: Text,
  hl: EditorHighlight,
  activeFile: string,
): HighlightDecorationMapping {
  const tierSpans = hl.sourceTiers
    ? [
        ...hl.sourceTiers.exact.map((span) => ({
          span,
          kind: 'primary' as const,
        })),
        ...hl.sourceTiers.contributing.map((span) => ({
          span,
          kind: 'contributing' as const,
        })),
      ]
    : hl.spans.map((span, index) => ({
        span,
        kind: index === hl.primary
          ? 'primary' as const
          : 'secondary' as const,
      }))
  const primarySpan = hl.sourceTiers?.exact[0] ?? hl.spans[hl.primary]
  const linePriority = new Map<number, HighlightDecorationKind>()
  tierSpans.forEach(({ span, kind }) => {
    if (span.file !== activeFile) return
    const start = Math.min(Math.max(span.startLine, 1), doc.lines)
    const end = Math.min(Math.max(span.endLine, start), doc.lines)
    for (let line = start; line <= end; line += 1) {
      linePriority.set(line, strongerHighlight(linePriority.get(line), kind))
    }
  })
  const decorations: HighlightDecoration[] = [
    ...linePriority.entries(),
  ]
    .sort(([a], [b]) => a - b)
    .map(([line, kind]) => ({ from: doc.line(line).from, kind }))

  tierSpans.forEach(({ span, kind }) => {
    if (span.file !== activeFile || !span.exact) return
    const startLine = doc.line(
      Math.min(Math.max(span.startLine, 1), doc.lines),
    )
    const endLine = doc.line(
      Math.min(Math.max(span.endLine, startLine.number), doc.lines),
    )
    const from =
      startLine.from +
      Math.min(Math.max(span.startCol - 1, 0), startLine.length)
    const to =
      endLine.from +
      Math.min(Math.max(span.endCol, 1), endLine.length)
    if (to > from) decorations.push({ from, to, kind })
  })
  decorations.sort(
    (left, right) =>
      left.from - right.from ||
      Number(left.to != null) - Number(right.to != null),
  )

  let primaryPosition: number | null = null
  if (primarySpan?.file === activeFile) {
    const primaryLineNumber = Math.min(
      Math.max(primarySpan.startLine, 1),
      doc.lines,
    )
    const line = doc.line(primaryLineNumber)
    primaryPosition =
      line.from +
      Math.min(Math.max(primarySpan.startCol - 1, 0), line.length)
  } else if (!hl.sourceTiers && decorations.length > 0) {
    primaryPosition = decorations[0].from
  }

  return { decorations, primaryPosition }
}
