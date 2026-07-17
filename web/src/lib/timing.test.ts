import { describe, expect, it } from 'vitest'
import { VIVADO_TIMING_CAVEAT, fmaxMhz } from './timing'

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

describe('VIVADO_TIMING_CAVEAT', () => {
  // The measured and estimated figures cover different path classes and handle
  // FF setup differently, and the UI shows no delta between them. The caveat
  // therefore carries the whole burden of stopping a reader from treating them
  // as a subtractable pair, so pin what it must say.
  it('states the path class the measurement is restricted to', () => {
    expect(VIVADO_TIMING_CAVEAT).toContain('register-to-register')
  })

  it('warns against subtracting the two figures', () => {
    expect(VIVADO_TIMING_CAVEAT).toContain('rather than subtracting')
  })

  it('explains the setup asymmetry in both directions', () => {
    expect(VIVADO_TIMING_CAVEAT).toContain('excludes FF setup')
    expect(VIVADO_TIMING_CAVEAT).toContain('includes setup')
  })

  it('does not claim to be timing closure', () => {
    expect(VIVADO_TIMING_CAVEAT).toContain('not timing closure')
  })
})
