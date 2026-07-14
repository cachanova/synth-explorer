import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TIMING_SETTINGS,
  isDefaultTiming,
  loadTimingSettings,
  saveTimingSettings,
  timingRequest,
  type TimingSettings,
} from './timingSettings'
import type { DelayModel } from '../types'

const MODEL: DelayModel = {
  lut_ps: 10,
  carry_ps: 10,
  wide_mux_ps: 10,
  cell_ps: 10,
  ff_clk_to_q_ps: 100,
  ff_setup_ps: 10,
  net_base_ps: 20,
  net_per_fanout_ps: 5,
}

describe('timingRequest', () => {
  const t = { targetMhz: null }
  it('omits profile for auto and defaults speed grade', () => {
    expect(timingRequest({ profile: 'auto', speedGrade: '-1', overrides: null, ...t })).toEqual({
      speed_grade: '-1',
    })
  })

  it('sends a named profile', () => {
    expect(
      timingRequest({ profile: 'ultrascale_plus', speedGrade: '-2', overrides: null, ...t }),
    ).toEqual({ profile: 'ultrascale_plus', speed_grade: '-2' })
  })

  it('a full override wins over the profile', () => {
    expect(
      timingRequest({ profile: 'series7', speedGrade: '-3', overrides: MODEL, ...t }),
    ).toEqual({ model: MODEL, speed_grade: '-3' })
  })

  it('never includes the display-only target clock', () => {
    const req = timingRequest({ profile: 'auto', speedGrade: '-1', overrides: null, targetMhz: 200 })
    expect(req).not.toHaveProperty('targetMhz')
  })
})

describe('isDefaultTiming', () => {
  it('is true only for auto / -1 / no overrides', () => {
    const base = { targetMhz: null }
    expect(isDefaultTiming(DEFAULT_TIMING_SETTINGS)).toBe(true)
    expect(isDefaultTiming({ profile: 'ice40', speedGrade: '-1', overrides: null, ...base })).toBe(
      false,
    )
    expect(isDefaultTiming({ profile: 'auto', speedGrade: '-2', overrides: null, ...base })).toBe(
      false,
    )
    expect(isDefaultTiming({ profile: 'auto', speedGrade: '-1', overrides: MODEL, ...base })).toBe(
      false,
    )
  })
})

describe('load/save round-trip', () => {
  beforeEach(() => {
    // Provide an in-memory localStorage for the node test environment.
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    })
  })

  it('returns defaults when nothing is stored', () => {
    expect(loadTimingSettings()).toEqual(DEFAULT_TIMING_SETTINGS)
  })

  it('persists and restores settings', () => {
    const s: TimingSettings = {
      profile: 'ecp5',
      speedGrade: '-3',
      overrides: MODEL,
      targetMhz: 250,
    }
    saveTimingSettings(s)
    expect(loadTimingSettings()).toEqual(s)
  })

  it('rejects a non-positive or non-numeric target clock', () => {
    localStorage.setItem(
      'synthexplorer.timing.v1',
      JSON.stringify({ profile: 'auto', speedGrade: '-1', overrides: null, targetMhz: -5 }),
    )
    expect(loadTimingSettings().targetMhz).toBeNull()
    localStorage.setItem(
      'synthexplorer.timing.v1',
      JSON.stringify({ profile: 'auto', speedGrade: '-1', overrides: null, targetMhz: 'fast' }),
    )
    expect(loadTimingSettings().targetMhz).toBeNull()
  })

  it('sanitizes invalid stored values', () => {
    localStorage.setItem(
      'synthexplorer.timing.v1',
      JSON.stringify({ profile: 'bogus', speedGrade: '-9', overrides: { lut_ps: 'x' } }),
    )
    expect(loadTimingSettings()).toEqual(DEFAULT_TIMING_SETTINGS)
  })

  it('rejects a partial override (missing coefficients)', () => {
    const { lut_ps: _drop, ...partial } = MODEL
    localStorage.setItem(
      'synthexplorer.timing.v1',
      JSON.stringify({ profile: 'series7', speedGrade: '-1', overrides: partial }),
    )
    expect(loadTimingSettings().overrides).toBeNull()
  })

  it('rejects non-finite coefficients', () => {
    localStorage.setItem(
      'synthexplorer.timing.v1',
      JSON.stringify({ profile: 'series7', speedGrade: '-1', overrides: { ...MODEL, lut_ps: null } }),
    )
    expect(loadTimingSettings().overrides).toBeNull()
  })

  it('falls back to defaults on malformed JSON', () => {
    localStorage.setItem('synthexplorer.timing.v1', '{not valid json')
    expect(loadTimingSettings()).toEqual(DEFAULT_TIMING_SETTINGS)
  })
})
