import { describe, expect, it } from 'vitest'
import { diffCellsByType, totalCellDelta } from './diff'

describe('diffCellsByType', () => {
  it('categorizes added / removed / changed / unchanged', () => {
    const a = { $_AND_: 4, $_NAND_: 2, $lut: 10 }
    const b = { $_AND_: 6, $lut: 10, $_XOR_: 3 }
    const d = diffCellsByType(a, b)

    expect(d.added.map((r) => r.type)).toEqual(['$_XOR_'])
    expect(d.added[0].delta).toBe(3)

    expect(d.removed.map((r) => r.type)).toEqual(['$_NAND_'])
    expect(d.removed[0].delta).toBe(-2)

    expect(d.changed.map((r) => r.type)).toEqual(['$_AND_'])
    expect(d.changed[0].delta).toBe(2)

    expect(d.unchanged.map((r) => r.type)).toEqual(['$lut'])
  })

  it('sorts changed by magnitude desc', () => {
    const a = { x: 10, y: 10, z: 10 }
    const b = { x: 11, y: 20, z: 5 }
    const d = diffCellsByType(a, b)
    expect(d.changed.map((r) => r.type)).toEqual(['y', 'z', 'x'])
  })

  it('handles empty maps', () => {
    const d = diffCellsByType({}, {})
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.changed).toEqual([])
    expect(d.unchanged).toEqual([])
  })

  it('totalCellDelta sums absolute changes', () => {
    const a = { x: 10, y: 5 }
    const b = { x: 12, z: 3 }
    // x: +2, y removed: -5, z added: +3 => 10
    expect(totalCellDelta(diffCellsByType(a, b))).toBe(10)
  })
})
