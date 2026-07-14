import { describe, expect, it } from 'vitest'
import { fmaxMhz, slackNs } from './timing'

describe('fmaxMhz', () => {
  it('converts a nanosecond period to megahertz', () => {
    // 10 ns period → 100 MHz
    expect(fmaxMhz(10)).toBeCloseTo(100)
    // 1 ns period → 1000 MHz
    expect(fmaxMhz(1)).toBeCloseTo(1000)
  })

  it('scales inversely with delay', () => {
    expect(fmaxMhz(5)).toBeGreaterThan(fmaxMhz(20))
  })
})

describe('slackNs', () => {
  it('is positive when the estimate meets the clock', () => {
    // 100 MHz -> 10 ns period; a 7 ns path has +3 ns slack
    expect(slackNs(7, 100)).toBeCloseTo(3)
  })

  it('is negative when the estimate fails the clock', () => {
    // 250 MHz -> 4 ns period; a 5 ns path misses by 1 ns
    expect(slackNs(5, 250)).toBeCloseTo(-1)
  })

  it('is zero at exactly the target period', () => {
    expect(slackNs(4, 250)).toBeCloseTo(0)
  })
})
