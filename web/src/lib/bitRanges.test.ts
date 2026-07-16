import { describe, expect, it } from 'vitest'
import { formatBitRanges } from './bitRanges'

describe('formatBitRanges', () => {
  it('deduplicates and combines descending Verilog ranges', () => {
    expect(formatBitRanges([0, 2, 1, 5, 5])).toBe('[5], [2:0]')
  })

  it('returns an empty label for no bits', () => {
    expect(formatBitRanges([])).toBe('')
  })
})
