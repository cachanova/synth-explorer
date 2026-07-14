import { describe, expect, it } from 'vitest'
import {
  getFlagValue,
  hasFlag,
  parseFamily,
  setFamily,
  setFlagValue,
  stripFlags,
  toggleFlag,
} from './synthFlags'

describe('synthFlags', () => {
  it('parses and writes the family (default = no token)', () => {
    expect(parseFamily('')).toBe('xc7')
    expect(parseFamily('-noabc -family xcup')).toBe('xcup')
    expect(parseFamily('-family bogus')).toBe('xc7')
    expect(setFamily('-noabc', 'xcup')).toBe('-noabc -family xcup')
    expect(setFamily('-family xcu -retime', 'xcup')).toBe('-retime -family xcup')
    expect(setFamily('-family xcup -noabc', 'xc7')).toBe('-noabc')
  })

  it('toggles boolean flags without duplication', () => {
    expect(hasFlag('-nocarry -nodsp', '-nocarry')).toBe(true)
    expect(hasFlag('-nodsp', '-nocarry')).toBe(false)
    expect(toggleFlag('-nodsp', '-nocarry', true)).toBe('-nodsp -nocarry')
    expect(toggleFlag('-nocarry -nodsp', '-nocarry', true)).toBe('-nodsp -nocarry')
    expect(toggleFlag('-nocarry -nodsp', '-nocarry', false)).toBe('-nodsp')
  })

  it('reads and writes value-taking flags', () => {
    expect(getFlagValue('-widemux 5 -nocarry', '-widemux')).toBe('5')
    expect(getFlagValue('-nocarry', '-widemux')).toBeNull()
    expect(setFlagValue('-nocarry', '-widemux', '5')).toBe('-nocarry -widemux 5')
    expect(setFlagValue('-widemux 3 -nocarry', '-widemux', '7')).toBe('-nocarry -widemux 7')
    expect(setFlagValue('-widemux 3 -nocarry', '-widemux', '')).toBe('-nocarry')
  })

  it('strips a set of flags, dropping values for value-taking ones', () => {
    expect(
      stripFlags('-nocarry -widemux 5 -noabc', [
        { flag: '-nocarry' },
        { flag: '-widemux', takesValue: true },
      ]),
    ).toBe('-noabc')
    // free-form / unknown tokens survive
    expect(stripFlags('-custom -nocarry', [{ flag: '-nocarry' }])).toBe('-custom')
  })
})
