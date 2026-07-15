import { describe, expect, it } from 'vitest'
import {
  dataPathEstimateNs,
  estimateErrorPct,
  fmaxMhz,
  slackNs,
} from './timing'
import type { DelayBreakdown } from '../types'

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

describe('dataPathEstimateNs', () => {
  const breakdown: DelayBreakdown = {
    launch_ns: 0.46,
    logic_ns: 1.4,
    net_ns: 0.75,
    setup_ns: 0.08,
  }

  it('removes the setup term Vivado excludes from Data Path Delay', () => {
    // The four terms sum to 2.69; Vivado's comparable figure drops setup.
    expect(dataPathEstimateNs(2.69, breakdown)).toBeCloseTo(2.61)
  })

  it('leaves launch, logic and route in place', () => {
    const estimate = dataPathEstimateNs(2.69, breakdown)
    expect(estimate).toBeCloseTo(
      breakdown.launch_ns + breakdown.logic_ns + breakdown.net_ns,
    )
  })

  it('is null without a breakdown to subtract setup from', () => {
    expect(dataPathEstimateNs(2.69, undefined)).toBeNull()
  })
})

describe('estimateErrorPct', () => {
  it('is positive when the estimate is pessimistic', () => {
    expect(estimateErrorPct(2.75, 2.5)).toBeCloseTo(10)
  })

  it('is negative when the estimate is optimistic', () => {
    expect(estimateErrorPct(2.25, 2.5)).toBeCloseTo(-10)
  })

  it('is zero on an exact match', () => {
    expect(estimateErrorPct(2.5, 2.5)).toBeCloseTo(0)
  })

  it('is null when the measurement cannot be a denominator', () => {
    expect(estimateErrorPct(2.5, 0)).toBeNull()
    expect(estimateErrorPct(2.5, -1)).toBeNull()
  })
})
