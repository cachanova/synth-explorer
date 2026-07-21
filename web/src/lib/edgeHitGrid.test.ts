import { describe, expect, it } from 'vitest'
import { edgeHitCellKeys } from './edgeHitGrid'

describe('edge hit grid', () => {
  it('indexes every cell crossed by a diagonal fallback edge', () => {
    expect(
      edgeHitCellKeys({ x: 150, y: 10 }, { x: 300, y: 170 }),
    ).toEqual(['0:0', '1:0', '1:1'])
    expect(
      edgeHitCellKeys({ x: 0, y: 0 }, { x: 320, y: 240 }),
    ).toEqual(['0:0', '1:0', '1:1', '2:1'])
  })
})
