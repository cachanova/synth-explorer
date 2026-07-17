import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TIMING_SETTINGS,
  compatibleTimingOverrides,
  editorModelForRequest,
  effectiveProfile,
  gateDelayValue,
  profilesForMode,
  ECP5_SPEED_GRADE_OPTIONS,
  PDK_PROFILES,
  PROFILE_OPTIONS,
  SPEED_GRADE_OPTIONS,
  isDefaultTiming,
  loadTimingSettings,
  saveTimingSettings,
  speedGradeOptions,
  timingRequest,
  timingRequestForMode,
  withGateDelay,
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

const ASIC_MODEL: DelayModel = {
  ...MODEL,
  gate_ps: { and: 11, xor: 22, not: 7 },
}

describe('ASIC gate overrides', () => {
  it('reads missing categories through cell_ps and edits them immutably', () => {
    const sparse: DelayModel = {
      ...ASIC_MODEL,
      cell_ps: 30,
      gate_ps: { and: 25.4, xor: 42.5 },
    }
    expect(gateDelayValue(sparse, 'mux')).toBe(30)

    const edited = withGateDelay(sparse, 'mux', 31)
    expect(edited.gate_ps).toEqual({ and: 25.4, xor: 42.5, mux: 31 })
    expect(edited.cell_ps).toBe(30)
    expect(sparse.gate_ps).toEqual({ and: 25.4, xor: 42.5 })
  })
})

describe('editor model provenance', () => {
  const result = { model: MODEL, requestKey: 'profile=series7' }

  it('uses only a response matching the current timing request', () => {
    expect(
      editorModelForRequest(null, result, 'profile=series7'),
    ).toBe(MODEL)
    expect(editorModelForRequest(null, result, 'profile=asap7')).toBeNull()
  })

  it('prefers a compatible active override over any response', () => {
    expect(
      editorModelForRequest(ASIC_MODEL, result, 'profile=asap7'),
    ).toBe(ASIC_MODEL)
  })
})

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

describe('timingRequestForMode', () => {
  const targetMhz = null

  it('keeps a PDK override on its gates-mode profile', () => {
    expect(
      timingRequestForMode(
        {
          profile: 'sky130hd',
          speedGrade: '-1',
          overrides: ASIC_MODEL,
          targetMhz,
        },
        'gates',
      ),
    ).toEqual({
      profile: 'sky130hd',
      speed_grade: '-1',
      model: ASIC_MODEL,
    })
  })

  it('suppresses a stored PDK override on an FPGA design', () => {
    const settings: TimingSettings = {
      profile: 'sky130hd',
      speedGrade: '-1',
      overrides: ASIC_MODEL,
      targetMhz,
    }
    expect(compatibleTimingOverrides(settings, 'xilinx')).toBeNull()
    expect(
      timingRequestForMode(settings, 'xilinx'),
    ).toEqual({ speed_grade: '-1' })
  })

  it('suppresses a legacy flat override under a named PDK profile', () => {
    const settings: TimingSettings = {
      profile: 'asap7',
      speedGrade: '-1',
      overrides: MODEL,
      targetMhz,
    }
    expect(compatibleTimingOverrides(settings, 'gates')).toBeNull()
    expect(
      timingRequestForMode(settings, 'gates'),
    ).toEqual({ profile: 'asap7', speed_grade: '-1' })
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

  it('persists and restores a sparse ASIC gate table', () => {
    const s: TimingSettings = {
      profile: 'sky130hd',
      speedGrade: '-1',
      overrides: ASIC_MODEL,
      targetMhz: null,
    }
    saveTimingSettings(s)
    expect(loadTimingSettings()).toEqual(s)

    const fallbackOnly = { ...s, overrides: { ...MODEL, gate_ps: {} } }
    saveTimingSettings(fallbackOnly)
    expect(loadTimingSettings()).toEqual(fallbackOnly)
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

  it('rejects unknown or non-numeric gate entries', () => {
    for (const gate_ps of [
      [],
      { and: 'slow' },
      { and: 10, aoi3: 20 },
    ]) {
      localStorage.setItem(
        'synthexplorer.timing.v1',
        JSON.stringify({
          profile: 'sky130hd',
          speedGrade: '-1',
          overrides: { ...MODEL, gate_ps },
        }),
      )
      expect(loadTimingSettings().overrides).toBeNull()
    }
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

describe('profilesForMode', () => {
  const values = (mode?: string) => profilesForMode(mode).map((o) => o.value)

  it('offers no FPGA presets for generic gates', () => {
    expect(values('gates')).toEqual([
      'auto',
      'sky130hd',
      'gf180mcu',
      'asap7',
      'generic',
    ])
  })

  it('offers no process nodes for FPGA and LUT targets', () => {
    for (const mode of ['xilinx', 'ice40', 'ecp5', 'lut4', 'lut6']) {
      expect(values(mode)).toEqual([
        'auto',
        'series7',
        'ultrascale',
        'ultrascale_plus',
        'ice40',
        'ecp5',
        'generic',
      ])
    }
  })

  it('falls back to the full list when the mode is unknown', () => {
    expect(values(undefined).length).toBeGreaterThan(7)
  })
})

describe('effectiveProfile', () => {
  it('clamps a stored profile that is invalid for the design mode to auto', () => {
    // Settings are global across designs: sky130hd picked on a gates design
    // must not retune a Xilinx netlist with standard-cell numbers.
    expect(effectiveProfile('sky130hd', 'xilinx')).toBe('auto')
    expect(effectiveProfile('series7', 'gates')).toBe('auto')
  })

  it('passes valid combinations through', () => {
    expect(effectiveProfile('sky130hd', 'gates')).toBe('sky130hd')
    expect(effectiveProfile('ultrascale', 'xilinx')).toBe('ultrascale')
    expect(effectiveProfile('ice40', 'lut4')).toBe('ice40')
    expect(effectiveProfile('generic', 'gates')).toBe('generic')
  })
})
