import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DelayBreakdown, DelayProfile } from '../types'
import { TimingModel } from './TimingModel'

// The four terms sum to the 2.69 ns estimate below.
const breakdown: DelayBreakdown = {
  launch_ns: 0.46,
  logic_ns: 1.4,
  net_ns: 0.75,
  setup_ns: 0.08,
}

// Static rendering never runs the effects, so the panel shows its fallback
// (synth-time) figures and never reaches the retune endpoint. Every field is
// passed explicitly: a defaulted parameter would swallow an intentional
// `undefined` and silently re-supply the value a test means to withhold.
function render(args: {
  estimate?: number | null
  breakdown?: DelayBreakdown
  mode?: string
  profile?: DelayProfile
}): string {
  return renderToStaticMarkup(
    <TimingModel
      designId="d"
      fallbackDelayNs={args.estimate ?? null}
      fallbackBreakdown={args.breakdown}
      designMode={args.mode}
      resolvedProfile={args.profile ?? 'generic'}
    />,
  )
}

describe('TimingModel estimate', () => {
  it('renders the browser-computed estimate and breakdown', () => {
    const markup = render({ estimate: 2.69, breakdown })
    expect(markup).toContain('Critical-path delay')
    expect(markup).toContain('2.69 ns')
    expect(markup).not.toContain('Vivado timing')
  })
})

describe('TimingModel coefficient vocabulary', () => {
  const sparseAsicModel = {
    lut_ps: 30,
    carry_ps: 67.9,
    wide_mux_ps: 30,
    cell_ps: 30,
    ff_clk_to_q_ps: 64.7,
    ff_setup_ps: 10,
    net_base_ps: 4,
    net_per_fanout_ps: 4,
    gate_ps: { and: 25.4, xor: 42.5, not: 21.2 },
  }

  it('shows standard-cell gate categories for an active PDK profile', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          profile: 'sky130hd',
          speedGrade: '-1',
          overrides: null,
        }),
      setItem: () => undefined,
    })
    try {
      const markup = renderToStaticMarkup(
        <TimingModel
          designId="d"
          designMode="gates"
          resolvedProfile="generic"
          fallbackDelayNs={2.69}
        />,
      )
      expect(markup).toContain('>AND<')
      expect(markup).toContain('XOR')
      expect(markup).toContain('Other gate')
      expect(markup).toContain('DFF clk→Q')
      expect(markup).not.toContain('LUT / gate')
      expect(markup).not.toContain('Carry stage')
      expect(markup).not.toContain('Wide mux')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps the existing FPGA categories for a non-PDK profile', () => {
    const markup = render({ estimate: 2.69 })
    expect(markup).toContain('LUT / gate')
    expect(markup).toContain('Carry stage')
    expect(markup).toContain('Wide mux')
    expect(markup).not.toContain('>AND<')
  })

  it('shows cell_ps as the effective value of a sparse gate override', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          profile: 'asap7',
          speedGrade: '-1',
          overrides: sparseAsicModel,
        }),
      setItem: () => undefined,
    })
    try {
      const markup = renderToStaticMarkup(
        <TimingModel
          designId="d"
          designMode="gates"
          resolvedProfile="generic"
          fallbackDelayNs={2.69}
        />,
      )
      expect(markup).toContain('Advanced: edit coefficients (ps) — custom')
      expect(markup).toMatch(/<span>MUX<\/span><input[^>]*value="30"/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not display a stored PDK override as active on an FPGA design', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          profile: 'sky130hd',
          speedGrade: '-1',
          overrides: sparseAsicModel,
        }),
      setItem: () => undefined,
    })
    try {
      const markup = renderToStaticMarkup(
        <TimingModel
          designId="d"
          designMode="xilinx"
          resolvedProfile="series7"
          fallbackDelayNs={2.69}
        />,
      )
      expect(markup).not.toContain('— custom')
      expect(markup).not.toContain('Reset to profile preset')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('renders no grade section for a gates design', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          profile: 'ecp5',
          speedGrade: '-1',
          overrides: null,
        }),
      setItem: () => undefined,
    })
    try {
      const markup = renderToStaticMarkup(
        <TimingModel
          designId="d"
          designMode="gates"
          resolvedProfile="generic"
          fallbackDelayNs={2.69}
        />,
      )
      expect(markup).not.toContain('Speed grade')
      expect(markup).not.toContain('-1 (slowest)')
      expect(markup).not.toContain('6 (slowest)')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('TimingModel generic-mode placeholder', () => {
  it('prompts gates users to choose a process node instead of showing timing cards', () => {
    const markup = render({ mode: 'gates', estimate: null })
    expect(markup).toContain('Pick a process node')
    expect(markup).toContain('Delay profile')
    expect(markup).not.toContain('Critical-path delay')
    expect(markup).not.toContain('Implied Fmax')
    expect(markup).not.toContain('Estimated timing')
    expect(markup).not.toContain('Advanced: edit coefficients')
    expect(markup).not.toContain('An estimate, not a measurement')
    expect(markup).not.toContain('Speed grade')
  })

  it('prompts LUT users to choose an FPGA preset', () => {
    for (const mode of ['lut4', 'lut6']) {
      const markup = render({ mode, estimate: null })
      expect(markup).toContain('Pick an FPGA preset')
      expect(markup).not.toContain('Critical-path delay')
    }
  })

  it('keeps normal timing cards for real FPGA modes', () => {
    const markup = render({
      mode: 'xilinx',
      profile: 'series7',
      estimate: 2.69,
      breakdown,
    })
    expect(markup).toContain('Critical-path delay')
    expect(markup).toContain('2.69 ns')
    expect(markup).not.toContain('Pick an FPGA preset')
    expect(markup).toContain('timing-profile-fixed')
    expect(markup).toContain('Xilinx 7-series')
  })

  it('uses HX/LP rather than numeric grades for iCE40', () => {
    const markup = render({ mode: 'ice40', profile: 'ice40', estimate: 2.69 })
    expect(markup).toContain('>HX<')
    expect(markup).toContain('>LP<')
    expect(markup).not.toContain('-1 (slowest)')
  })

})
