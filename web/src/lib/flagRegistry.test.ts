import { describe, expect, it } from 'vitest'
import {
  flagsForMode,
  flagsForModeChange,
  flagsForTool,
  stripInvalidFlags,
} from './flagRegistry'

describe('flagRegistry', () => {
  it('exposes per-mode flags and none for rtl', () => {
    expect(flagsForMode('xilinx').some((d) => d.flag === '-nocarry')).toBe(true)
    expect(flagsForMode('ecp5').some((d) => d.flag === '-noccu2')).toBe(true)
    // ecp5 uses -noccu2, not -nocarry
    expect(flagsForMode('ecp5').some((d) => d.flag === '-nocarry')).toBe(false)
    expect(flagsForMode('rtl')).toEqual([])
  })

  it('exposes curated Vivado synth_design flags independently of Yosys mode', () => {
    const definitions = flagsForTool('vivado', 'gates')
    expect(definitions.map((d) => d.flag)).toContain(
      '-no_srlextract',
    )
    expect(definitions.map((d) => d.flag)).toContain('-global_retiming')
    expect(definitions.map((d) => d.flag)).not.toContain('-retiming')

    const directive = definitions.find((d) => d.flag === '-directive')
    expect(directive).toMatchObject({
      value: 'select',
      defaultValue: 'default',
    })
    expect(directive?.value === 'select' && directive.choices).toContain(
      'PerformanceOptimized',
    )

    expect(definitions.find((d) => d.flag === '-max_dsp')).toMatchObject({
      value: 'int',
      defaultValue: '0',
      min: -1,
    })
    expect(flagsForTool('yosys', 'gates')).toEqual(flagsForMode('gates'))
  })

  it('strips flags invalid for the new mode, keeping shared and free-form ones', () => {
    // -family/-retime/-noiopad are xilinx; -nobram is shared with ecp5; -custom is free-form
    expect(
      stripInvalidFlags('-family xcup -retime -nobram -custom', 'ecp5'),
    ).toBe('-nobram -custom')
    // switching to a generic mode drops all vendor flags but keeps generic ones
    expect(stripInvalidFlags('-family xcup -nocarry -noabc', 'gates')).toBe('-noabc')
    // rtl has no flags -> everything known is stripped, free-form kept
    expect(stripInvalidFlags('-nocarry -custom', 'rtl')).toBe('-custom')
  })

  it('drops the value token of value-taking flags when stripping', () => {
    expect(stripInvalidFlags('-widemux 5 -noabc', 'gates')).toBe('-noabc')
  })

  it('applies each registry defaultOn flag on mode change, visibly', () => {
    // Defaults are ordinary flags in the visible string, never injected
    // server-side — the user can see and remove them.
    expect(flagsForModeChange('', 'xilinx')).toBe('-nowidelut -noiopad')
    expect(flagsForModeChange('-nocarry', 'xilinx')).toBe(
      '-nocarry -nowidelut -noiopad',
    )
    // ECP5 defaults only -noiopad: -nowidelut is Xilinx-measured evidence.
    expect(flagsForModeChange('', 'ecp5')).toBe('-noiopad')
    // Leaving a vendor mode drops its defaults with the rest of its flags.
    expect(flagsForModeChange('-nowidelut -noiopad', 'gates')).toBe('')
    // Already-present defaults are not duplicated.
    expect(flagsForModeChange('-nowidelut -noiopad', 'xilinx')).toBe(
      '-nowidelut -noiopad',
    )
  })
})
