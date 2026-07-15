import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
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
}): string {
  return renderToStaticMarkup(
    <TimingModel
      designId="d"
      fallbackDelayNs={args.estimate ?? null}
      fallbackBreakdown={args.breakdown}
      vivadoTiming={args.timing}
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
    expect(markup).not.toContain('vivado-compare')
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

  it('labels which figure is measured and which is estimated', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69, breakdown })
    expect(markup).toContain('measured')
    expect(markup).toContain('estimated')
  })

  it('compares like for like by dropping the setup term Vivado excludes', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69, breakdown })
    // 2.69 - 0.08 setup = 2.61 ns, against Vivado's 2.616 ns => -0.2%.
    expect(markup).toContain('2.61 ns')
    expect(markup).toContain('-0.2%')
    expect(markup).toContain('excluding FF setup')
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
  // drop the comparison instead of inventing a denominator.
  it('still shows the measured delay when there is no estimate to compare', () => {
    const markup = render({ timing: vivadoTiming, estimate: null })
    expect(markup).toContain('Vivado data-path delay')
    expect(markup).toContain('2.62 ns')
    expect(markup).not.toContain('vivado-compare')
  })

  // An estimate with no breakdown cannot have its setup term removed, so there
  // is no like-for-like figure to compare.
  it('omits the comparison when the estimate has no setup term to remove', () => {
    const markup = render({ timing: vivadoTiming, estimate: 2.69 })
    expect(markup).toContain('Vivado data-path delay')
    expect(markup).not.toContain('vivado-compare')
  })
})
