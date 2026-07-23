import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DelayModel, DelayProfile } from '../types'
import {
  DEFAULT_TIMING_SETTINGS,
  compatibleTimingOverrides,
  editorModelForRequest,
  gateDelayValue,
  loadTimingSettings,
  resolveTimingView,
  saveTimingSettings,
  timingRequestForView,
  withGateDelay,
  type TimingSettings,
} from './timingSettings'

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

function settings(patch: Partial<TimingSettings> = {}): TimingSettings {
  return { ...DEFAULT_TIMING_SETTINGS, ...patch }
}

function view(
  mode: string,
  profile: DelayProfile,
  patch: Partial<TimingSettings> = {},
) {
  return resolveTimingView(settings(patch), mode, profile)
}

describe('resolved TimingView', () => {
  it('locks concrete FPGA designs to their resolved profile', () => {
    for (const [mode, profile] of [
      ['xilinx', 'ultrascale_plus'],
      ['ecp5', 'ecp5'],
      ['ice40', 'ice40'],
    ] as const) {
      const resolved = view(mode, profile, { profile: 'sky130hd' })
      expect(resolved.profileLocked).toBe(true)
      expect(resolved.profile).toBe(profile)
      expect(resolved.profileOptions.map((option) => option.value)).toEqual([
        profile,
      ])
      expect(resolved.showTiming).toBe(true)
    }
  })

  it('offers only process nodes for gates and never shows a grade section', () => {
    const auto = view('gates', 'generic')
    expect(auto.profileOptions.map((option) => option.value)).toEqual([
      'auto',
      'sky130hd',
      'gf180mcu',
      'asap7',
    ])
    expect(auto.showTiming).toBe(false)
    expect(auto.showGradeSection).toBe(false)
    expect(auto.caveat).toBe('')

    const selected = view('gates', 'generic', { profile: 'sky130hd' })
    expect(selected.showTiming).toBe(true)
    expect(selected.showGradeSection).toBe(false)
    expect(selected.gradeOptions).toEqual([])
  })

  it('offers FPGA presets for LUT modes and hides all timing until selected', () => {
    for (const mode of ['lut4', 'lut6']) {
      const auto = view(mode, 'generic')
      expect(auto.showTiming).toBe(false)
      expect(auto.showGradeSection).toBe(false)
      expect(auto.profileOptions.map((option) => option.value)).toEqual([
        'auto',
        'series7',
        'ultrascale',
        'ultrascale_plus',
        'ice40',
        'ecp5',
      ])
      expect(view(mode, 'generic', { profile: 'series7' }).showTiming).toBe(true)
    }
  })

  it('hides timing and controls in RTL', () => {
    const resolved = view('rtl', 'generic')
    expect(resolved.showTiming).toBe(false)
    expect(resolved.showGradeSection).toBe(false)
    expect(resolved.profileOptions).toEqual([])
  })

  it('uses wire-accurate ECP5 and iCE40 grade axes', () => {
    const ecp5 = view('ecp5', 'ecp5', { speedGrade: '-3' })
    expect(ecp5.gradeOptions).toEqual([
      { value: '-1', label: '6 (slowest)' },
      { value: '-2', label: '7' },
      { value: '-3', label: '8 (fastest)' },
    ])
    expect(ecp5.grade).toBe('-3')

    const ice40 = view('ice40', 'ice40', { speedGrade: '-3' })
    expect(ice40.gradeOptions).toEqual([
      { value: 'hx', label: 'HX' },
      { value: 'lp', label: 'LP' },
    ])
    expect(ice40.grade).toBe('hx')
    expect(view('ice40', 'ice40', { speedGrade: 'lp' }).grade).toBe('lp')
  })

  it('clamps stale global profiles only once, in the view', () => {
    expect(view('gates', 'generic', { profile: 'series7' }).profile).toBe('auto')
    expect(view('lut4', 'generic', { profile: 'sky130hd' }).profile).toBe('auto')
  })

  it('makes the caveat recommendation match the resolved technology', () => {
    expect(view('xilinx', 'series7').caveat).toContain('Vivado')
    expect(view('ecp5', 'ecp5').caveat).toContain('nextpnr')
    expect(view('ice40', 'ice40').caveat).toContain('icetime')
    expect(view('gates', 'generic', { profile: 'asap7' }).caveat).toContain(
      'OpenSTA',
    )
  })
})

describe('timing request from the resolved view', () => {
  it('uses the locked profile and clamped grade on the wire', () => {
    const stored = settings({ profile: 'sky130hd', speedGrade: '-3' })
    const resolved = resolveTimingView(stored, 'ice40', 'ice40')
    expect(timingRequestForView(stored, resolved)).toEqual({
      profile: 'ice40',
      speed_grade: 'hx',
    })
  })

  it('omits auto, and sends a selected profile with a compatible override', () => {
    const auto = settings()
    expect(timingRequestForView(auto, view('gates', 'generic'))).toEqual({
      speed_grade: '-1',
    })

    const pdk = settings({ profile: 'sky130hd', overrides: ASIC_MODEL })
    const resolved = resolveTimingView(pdk, 'gates', 'generic')
    expect(timingRequestForView(pdk, resolved)).toEqual({
      profile: 'sky130hd',
      speed_grade: '-1',
      model: ASIC_MODEL,
    })
  })

  it('suppresses overrides from the wrong technology class', () => {
    const pdk = settings({ profile: 'sky130hd', overrides: ASIC_MODEL })
    const fpgaView = resolveTimingView(pdk, 'xilinx', 'series7')
    expect(compatibleTimingOverrides(pdk, fpgaView)).toBeNull()

    const flat = settings({ profile: 'asap7', overrides: MODEL })
    const pdkView = resolveTimingView(flat, 'gates', 'generic')
    expect(compatibleTimingOverrides(flat, pdkView)).toBeNull()
  })
})

describe('coefficient editor helpers', () => {
  it('uses cell_ps for sparse categories and edits immutably', () => {
    const sparse = { ...ASIC_MODEL, cell_ps: 30, gate_ps: { and: 25.4 } }
    expect(gateDelayValue(sparse, 'mux')).toBe(30)
    const edited = withGateDelay(sparse, 'mux', 31)
    expect(edited.gate_ps).toEqual({ and: 25.4, mux: 31 })
    expect(sparse.gate_ps).toEqual({ and: 25.4 })
  })

  it('never seeds an edit from a stale response', () => {
    const result = { model: MODEL, requestKey: 'series7' }
    expect(editorModelForRequest(null, result, 'series7')).toBe(MODEL)
    expect(editorModelForRequest(null, result, 'asap7')).toBeNull()
    expect(editorModelForRequest(ASIC_MODEL, result, 'asap7')).toBe(ASIC_MODEL)
  })
})

describe('load/save round-trip', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    })
  })

  it('returns defaults when nothing is stored', () => {
    expect(loadTimingSettings()).toEqual(DEFAULT_TIMING_SETTINGS)
  })

  it('persists current settings and iCE40 grades', () => {
    const stored = settings({ profile: 'ice40', speedGrade: 'lp', overrides: MODEL })
    saveTimingSettings(stored)
    expect(loadTimingSettings()).toEqual(stored)
  })

  it('persists a sparse ASIC gate table', () => {
    const stored = settings({ profile: 'sky130hd', overrides: ASIC_MODEL })
    saveTimingSettings(stored)
    expect(loadTimingSettings()).toEqual(stored)

    const fallbackOnly = settings({
      profile: 'sky130hd',
      overrides: { ...MODEL, gate_ps: {} },
    })
    saveTimingSettings(fallbackOnly)
    expect(loadTimingSettings()).toEqual(fallbackOnly)
  })

  it('tolerates and drops legacy targetMhz from old blobs', () => {
    localStorage.setItem(
      'synthexplorer.timing.v1',
      JSON.stringify({ ...settings({ profile: 'ecp5' }), targetMhz: 250 }),
    )
    const loaded = loadTimingSettings()
    expect(loaded).toEqual(settings({ profile: 'ecp5' }))
    expect(loaded).not.toHaveProperty('targetMhz')
    saveTimingSettings(loaded)
    expect(localStorage.getItem('synthexplorer.timing.v1')).not.toContain(
      'targetMhz',
    )
  })

  it('sanitizes malformed values and partial overrides', () => {
    localStorage.setItem(
      'synthexplorer.timing.v1',
      JSON.stringify({ profile: 'bogus', speedGrade: '-9', overrides: { lut_ps: 1 } }),
    )
    expect(loadTimingSettings()).toEqual(DEFAULT_TIMING_SETTINGS)

    const { lut_ps: _missing, ...partial } = MODEL
    localStorage.setItem(
      'synthexplorer.timing.v1',
      JSON.stringify({ profile: 'series7', speedGrade: '-1', overrides: partial }),
    )
    expect(loadTimingSettings().overrides).toBeNull()

    for (const gate_ps of [[], { and: 'slow' }, { and: 10, aoi3: 20 }]) {
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

    localStorage.setItem('synthexplorer.timing.v1', '{broken')
    expect(loadTimingSettings()).toEqual(DEFAULT_TIMING_SETTINGS)
  })
})
