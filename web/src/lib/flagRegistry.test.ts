import { describe, expect, it } from 'vitest'
import {
  flagsForMode,
  flagsForModeChange,
  flagsForModeTransition,
  flagsForVivadoChange,
  stripInvalidFlags,
  VIVADO_FLAG_REGISTRY,
} from './flagRegistry'

describe('flagRegistry', () => {
  it('exposes per-mode flags and none for rtl', () => {
    expect(flagsForMode('xilinx').some((d) => d.flag === '-nocarry')).toBe(true)
    expect(flagsForMode('ecp5').some((d) => d.flag === '-noccu2')).toBe(true)
    // ecp5 uses -noccu2, not -nocarry
    expect(flagsForMode('ecp5').some((d) => d.flag === '-nocarry')).toBe(false)
    expect(flagsForMode('rtl')).toEqual([])
  })

  it('exposes curated Vivado flags with logic-only synthesis visibly enabled by default', () => {
    expect(VIVADO_FLAG_REGISTRY.some((d) => d.flag === '-directive')).toBe(true)
    expect(VIVADO_FLAG_REGISTRY.some((d) => d.flag === '-global_retiming')).toBe(true)
    expect(flagsForVivadoChange('')).toBe('-mode out_of_context')
    expect(flagsForVivadoChange('-max_dsp 0')).toBe('-max_dsp 0 -mode out_of_context')
    expect(flagsForVivadoChange('-mode default')).toBe('-mode default')
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
    // out of band — the user can see and remove them.
    expect(flagsForModeChange('', 'xilinx')).toBe(
      '-narrowcarry 8 -nowidelut -noiopad',
    )
    expect(flagsForModeChange('-nocarry', 'xilinx')).toBe(
      '-nocarry -narrowcarry 8 -nowidelut -noiopad',
    )
    // A user-tuned value survives the mode-change default pass.
    expect(flagsForModeChange('-narrowcarry 4', 'xilinx')).toBe(
      '-narrowcarry 4 -nowidelut -noiopad',
    )
    // ECP5 defaults only -noiopad: -nowidelut is Xilinx-measured evidence.
    expect(flagsForModeChange('', 'ecp5')).toBe('-noiopad')
    // Leaving a vendor mode drops its defaults with the rest of its flags.
    expect(flagsForModeChange('-narrowcarry 8 -nowidelut -noiopad', 'gates')).toBe('')
    // Already-present defaults are not duplicated.
    expect(flagsForModeChange('-narrowcarry 8 -nowidelut -noiopad', 'xilinx')).toBe(
      '-narrowcarry 8 -nowidelut -noiopad',
    )
  })

  it('restores exact per-mode edits across a real Xilinx/ECP5 round-trip', () => {
    let memory = {}
    let transition = flagsForModeTransition('', 'gates', 'xilinx', memory)
    expect(transition.flags).toBe('-narrowcarry 8 -nowidelut -noiopad')

    // The user tunes narrow-carry and removes a default before leaving.
    transition = flagsForModeTransition(
      '-narrowcarry 4 -noiopad',
      'xilinx',
      'ecp5',
      transition.memory,
    )
    memory = transition.memory
    expect(transition.flags).toBe('-noiopad')
    expect(transition.flags).not.toContain('-nowidelut')

    // ECP5 remembers its own edits, while Xilinx returns byte-for-byte.
    transition = flagsForModeTransition(
      '-noccu2',
      'ecp5',
      'xilinx',
      memory,
    )
    expect(transition.flags).toBe('-narrowcarry 4 -noiopad')
    transition = flagsForModeTransition(
      transition.flags,
      'xilinx',
      'ecp5',
      transition.memory,
    )
    expect(transition.flags).toBe('-noccu2')
  })
})
