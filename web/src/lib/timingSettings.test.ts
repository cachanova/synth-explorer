import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TIMING_SETTINGS,
  ECP5_SPEED_GRADE_OPTIONS,
  PDK_PROFILES,
  PROFILE_OPTIONS,
  SPEED_GRADE_OPTIONS,
  isDefaultTiming,
  loadTimingSettings,
  saveTimingSettings,
  speedGradeOptions,
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

  it('sends an override and the profile together', () => {
    // The two answer different questions: the override supplies the
    // coefficients, the profile picks whose speed-grade scaling applies. Sending
    // only the override left the dropdown showing one family while the server
    // scaled by the design's.
    expect(
      timingRequest({ profile: 'series7', speedGrade: '-3', overrides: MODEL, ...t }),
    ).toEqual({ model: MODEL, profile: 'series7', speed_grade: '-3' })
  })

  it('omits the profile on auto even with an override', () => {
    // 'auto' means "the design's own family" -- the server resolves that.
    expect(
      timingRequest({ profile: 'auto', speedGrade: '-2', overrides: MODEL, ...t }),
    ).toEqual({ model: MODEL, speed_grade: '-2' })
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

describe('speedGradeOptions', () => {
  it('labels ECP5 grades by their real names when the profile is ecp5', () => {
    const labels = speedGradeOptions('ecp5').map((o) => o.label)
    expect(labels).toEqual(['6 (slowest)', '7', '8 (fastest)'])
    // The wire values stay '-1'/'-2'/'-3' — only the labels change.
    expect(speedGradeOptions('ecp5').map((o) => o.value)).toEqual(['-1', '-2', '-3'])
  })

  it('resolves auto to ECP5 labels only for an ECP5 design', () => {
    expect(speedGradeOptions('auto', 'ecp5')).toBe(ECP5_SPEED_GRADE_OPTIONS)
    expect(speedGradeOptions('auto', 'xilinx')).toBe(SPEED_GRADE_OPTIONS)
    expect(speedGradeOptions('auto')).toBe(SPEED_GRADE_OPTIONS)
  })

  it('keeps generic grade labels for the non-ECP5 profiles', () => {
    for (const profile of ['series7', 'ice40', 'sky130hd', 'generic'] as const) {
      expect(speedGradeOptions(profile)).toBe(SPEED_GRADE_OPTIONS)
    }
  })
})

describe('PDK profiles', () => {
  it('every PDK profile is selectable in the dropdown', () => {
    const values = new Set(PROFILE_OPTIONS.map((o) => o.value))
    for (const profile of PDK_PROFILES) expect(values.has(profile)).toBe(true)
  })

  it('flags exactly the ASIC library profiles', () => {
    expect([...PDK_PROFILES].sort()).toEqual(['asap7', 'gf180mcu', 'sky130hd'])
    expect(PDK_PROFILES.has('ecp5')).toBe(false)
    expect(PDK_PROFILES.has('auto')).toBe(false)
  })
})
