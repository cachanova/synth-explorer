import { describe, expect, it } from 'vitest'
import {
  parseFamily,
  parseRetime,
  setFamily,
  setRetime,
  stripXilinxFlags,
} from './synthFlags'

describe('synthFlags', () => {
  it('parses family and retime out of a flags string', () => {
    expect(parseFamily('')).toBe('xc7') // default when absent
    expect(parseFamily('-noabc -family xcup -retime')).toBe('xcup')
    expect(parseFamily('-family bogus')).toBe('xc7') // invalid -> default
    expect(parseRetime('-family xcup')).toBe(false)
    expect(parseRetime('-noabc -retime')).toBe(true)
  })

  it('writes family, keeping the default as no token', () => {
    expect(setFamily('-noabc', 'xcup')).toBe('-noabc -family xcup')
    // switching families replaces, never duplicates
    expect(setFamily('-family xcu -retime', 'xcup')).toBe('-retime -family xcup')
    // the default removes the token
    expect(setFamily('-family xcup -noabc', 'xc7')).toBe('-noabc')
  })

  it('toggles retime idempotently', () => {
    expect(setRetime('-family xcup', true)).toBe('-family xcup -retime')
    expect(setRetime('-retime -family xcup', true)).toBe('-family xcup -retime') // no dup
    expect(setRetime('-retime -family xcup', false)).toBe('-family xcup')
  })

  it('round-trips a control edit through the flags string', () => {
    let flags = ''
    flags = setFamily(flags, 'xcup')
    flags = setRetime(flags, true)
    expect(flags).toBe('-family xcup -retime')
    expect(parseFamily(flags)).toBe('xcup')
    expect(parseRetime(flags)).toBe(true)
  })

  it('strips xilinx-only flags but keeps other tokens', () => {
    expect(stripXilinxFlags('-family xcup -retime -noabc')).toBe('-noabc')
    expect(stripXilinxFlags('-nofsm')).toBe('-nofsm')
  })
})
