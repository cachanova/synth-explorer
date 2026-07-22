import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { selectedSourceRange } from '../lib/editorSourceSelection'

const document = 'logic first; logic second;\nlogic third;\n'

function range(anchor: number, head = anchor) {
  return selectedSourceRange(
    EditorState.create({
      doc: document,
      selection: EditorSelection.single(anchor, head),
    }),
  )
}

describe('editor source coordinates', () => {
  it('distinguishes carets on declarations sharing a line', () => {
    expect(range(document.indexOf('first') + 2)).toEqual({
      startLine: 1,
      startColumn: 9,
      endLine: 1,
      endColumn: 9,
      fallbackStartColumn: 1,
      fallbackEndColumn: 12,
    })
    expect(range(document.indexOf('second') + 2)).toEqual({
      startLine: 1,
      startColumn: 22,
      endLine: 1,
      endColumn: 22,
      fallbackStartColumn: 13,
      fallbackEndColumn: 26,
    })
  })

  it('bounds a missed caret to the surrounding semicolon statement', () => {
    expect(range(document.indexOf('logic second'))).toEqual({
      startLine: 1,
      startColumn: 14,
      endLine: 1,
      endColumn: 14,
      fallbackStartColumn: 13,
      fallbackEndColumn: 26,
    })
    expect(range(document.indexOf('logic third'))).toEqual({
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 1,
      fallbackStartColumn: 1,
      fallbackEndColumn: 12,
    })
  })

  it('omits fallback coordinates instead of scanning an oversized line', () => {
    const longDocument = `logic value;${' '.repeat(4096)}`
    const selected = selectedSourceRange(
      EditorState.create({
        doc: longDocument,
        selection: EditorSelection.cursor(longDocument.indexOf('value')),
      }),
    )

    expect(selected).toEqual({
      startLine: 1,
      startColumn: 7,
      endLine: 1,
      endColumn: 7,
    })
  })

  it('ignores semicolons inside comments and strings', () => {
    const complex = 'logic first = "a;b" /* ; */; logic second;'
    const second = complex.indexOf('logic second')
    const separator = complex.indexOf(';', complex.indexOf('*/'))
    const terminator = complex.indexOf(';', second)
    const selected = selectedSourceRange(
      EditorState.create({
        doc: complex,
        selection: EditorSelection.cursor(second),
      }),
    )

    expect(selected.fallbackStartColumn).toBe(separator + 2)
    expect(selected.fallbackEndColumn).toBe(terminator + 1)
  })

  it('uses inclusive endpoints for forward and backward selections', () => {
    const first = document.indexOf('first')
    const secondEnd = document.indexOf('second') + 'second'.length
    expect(range(first, secondEnd)).toEqual(range(secondEnd, first))
    expect(range(first, secondEnd)).toEqual({
      startLine: 1,
      startColumn: 7,
      endLine: 1,
      endColumn: 25,
    })
  })

  it('excludes the next line when a selection ends at its first character', () => {
    expect(range(0, document.indexOf('logic third'))).toEqual({
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 26,
    })
  })
})
