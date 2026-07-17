import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { VIVADO_TIMING_CAVEAT } from '../lib/timing'
import type { DelayBreakdown, VivadoTiming } from '../types'
import { TimingModel } from './TimingModel'

// The four terms sum to the 2.69 ns estimate below.
const breakdown: DelayBreakdown = {
  launch_ns: 0.46,
  logic_ns: 1.4,
  net_ns: 0.75,
  setup_ns: 0.08,
}

// The figures the server's real-fixture parser test produces.
const vivadoTiming: VivadoTiming = {
  data_path_delay_ns: 2.616,
  logic_ns: 1.855,
  route_ns: 0.761,
  logic_levels: 5,
  slack_ns: 7.28,
  slack_met: true,
  reference_period_ns: 10,
  source: 'ra_reg[1]/C',
  destination: 'q_reg[13]/D',
}

// Static rendering never runs the effects, so the panel shows its fallback
// (synth-time) figures and never reaches the retune endpoint. Every field is
// passed explicitly: a defaulted parameter would swallow an intentional
// `undefined` and silently re-supply the value a test means to withhold.
function render(args: {
  timing?: VivadoTiming
  estimate?: number | null
  breakdown?: DelayBreakdown
  mode?: string
}): string {
  return renderToStaticMarkup(
    <TimingModel
      designId="d"
      fallbackDelayNs={args.estimate ?? null}
      fallbackBreakdown={args.breakdown}
      vivadoTiming={args.timing}
      designMode={args.mode}
    />,
  )
}

describe('TimingModel Vivado tier', () => {
  it('renders identically to the estimate-only panel when Vivado timing is absent', () => {
    const markup = render({ estimate: 2.69, breakdown })
    // Nothing from the measured tier may appear. ("Vivado" itself is not a
    // usable marker: the long-standing estimate caveat names the tool the
    // presets are calibrated against.)
    expect(markup).not.toContain('Vivado timing')
    expect(markup).not.toContain('Vivado data-path delay')
    expect(markup).not.toContain('vivado-path')
    expect(markup).not.toContain('tier-tag')
    expect(markup).not.toContain(VIVADO_TIMING_CAVEAT)
    // The Yosys path must be untouched: still the plain estimate panel.
    expect(markup).toContain('Critical-path delay')
    expect(markup).toContain('2.69 ns')
  })

  it('shows the measured Vivado delay beside the estimate', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69, breakdown })
    expect(markup).toContain('Critical-path delay')
    expect(markup).toContain('2.69 ns') // estimate, setup included
    expect(markup).toContain('Vivado data-path delay')
    expect(markup).toContain('2.62 ns') // measured
  })

  // Both tiers are on screen together, so each has to say which it is.
  it('labels which figure is measured and which is estimated', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69, breakdown })
    expect(markup).toContain('tier-measured">measured')
    expect(markup).toContain('tier-estimated">estimated')
  })

  // The estimate and the measurement do not describe the same path, so the
  // panel must not print a delta between them however tempting it looks.
  it('shows no estimate-vs-measured delta', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69, breakdown })
    expect(markup).not.toContain('%<')
    // 2.69 - 0.08 setup: the "comparable" figure that used to be derived here.
    expect(markup).not.toContain('2.61 ns')
  })

  it('says why the two figures are not subtractable', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69, breakdown })
    expect(markup).toContain('rather than subtracting')
    expect(markup).toContain('Worst register-to-register path')
  })

  it('reports slack against the reference clock rather than a user target', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69, breakdown })
    expect(markup).toContain('ra_reg[1]/C')
    expect(markup).toContain('q_reg[13]/D')
    expect(markup).toContain('10 ns')
    expect(markup).toContain('reference clock')
  })

  it('surfaces the logic and route split and the logic-level count', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69, breakdown })
    expect(markup).toContain('1.85 ns') // logic
    expect(markup).toContain('0.76 ns') // route
    expect(markup).toContain('Logic levels')
    expect(markup).toContain('>5<')
  })

  // A design with no combinational logic has no Tier-0 estimate but still has
  // a real Vivado measurement. Show the measurement rather than nothing, and
  // drop any delta instead of inventing a denominator.
  it('still shows the measured delay when there is no estimate at all', () => {
    const markup = render({ timing: vivadoTiming, estimate: null })
    expect(markup).toContain('Vivado data-path delay')
    expect(markup).toContain('2.62 ns')
  })

  it('renders the measured tier without an estimate breakdown', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69 })
    expect(markup).toContain('Vivado data-path delay')
    expect(markup).toContain('2.62 ns')
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
          targetMhz: null,
        }),
      setItem: () => undefined,
    })
    try {
      const markup = renderToStaticMarkup(
        <TimingModel
          designId="d"
          designMode="gates"
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
          targetMhz: null,
        }),
      setItem: () => undefined,
    })
    try {
      const markup = renderToStaticMarkup(
        <TimingModel
          designId="d"
          designMode="gates"
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
          targetMhz: null,
        }),
      setItem: () => undefined,
    })
    try {
      const markup = renderToStaticMarkup(
        <TimingModel
          designId="d"
          designMode="xilinx"
          fallbackDelayNs={2.69}
        />,
      )
      expect(markup).not.toContain('— custom')
      expect(markup).not.toContain('Reset to profile preset')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('clamps stored FPGA grade labels when viewing a gates design', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          profile: 'ecp5',
          speedGrade: '-1',
          overrides: null,
          targetMhz: null,
        }),
      setItem: () => undefined,
    })
    try {
      const markup = renderToStaticMarkup(
        <TimingModel
          designId="d"
          designMode="gates"
          fallbackDelayNs={2.69}
        />,
      )
      expect(markup).toContain('-1 (slowest)')
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
  })

  it('prompts LUT users to choose an FPGA preset', () => {
    for (const mode of ['lut4', 'lut6']) {
      const markup = render({ mode, estimate: null })
      expect(markup).toContain('Pick an FPGA preset')
      expect(markup).not.toContain('Critical-path delay')
    }
  })

  it('keeps normal timing cards for real FPGA modes', () => {
    const markup = render({ mode: 'xilinx', estimate: 2.69, breakdown })
    expect(markup).toContain('Critical-path delay')
    expect(markup).toContain('2.69 ns')
    expect(markup).not.toContain('Pick an FPGA preset')
  })
})
