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
    expect(flagsForTool('vivado', 'gates').map((d) => d.flag)).toContain(
      '-retiming',
    )
    expect(flagsForTool('vivado', 'gates').map((d) => d.flag)).toContain(
      '-no_srlextract',
    )
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

  it('defaults supported vendor modes to netlists without IO pads', () => {
    expect(flagsForModeChange('', 'xilinx')).toBe('-noiopad')
    expect(flagsForModeChange('-nocarry', 'xilinx')).toBe('-nocarry -noiopad')
    expect(flagsForModeChange('-noiopad', 'gates')).toBe('')
  })
})
