import { describe, expect, it } from 'vitest'
import { fmaxMhz } from './timing'

describe('fmaxMhz', () => {
  it('converts a nanosecond period to megahertz', () => {
    // 10 ns period → 100 MHz
    expect(fmaxMhz(10)).toBeCloseTo(100)
    // 1 ns period → 1000 MHz
    expect(fmaxMhz(1)).toBeCloseTo(1000)
  })
})
