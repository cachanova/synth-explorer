import { describe, expect, it } from 'vitest'
import {
  fanoutDriverLabel,
  isHiddenName,
  prettyCellType,
  shortNetName,
} from './prettyType'
import type { NodeRef } from '../types'

describe('prettyCellType', () => {
  it('strips gate-primitive wrappers', () => {
    expect(prettyCellType('$_NAND_')).toBe('NAND')
    expect(prettyCellType('$_SDFF_PP0_')).toBe('SDFF_PP0')
  })
  it('strips $ from RTL cells', () => {
    expect(prettyCellType('$add')).toBe('ADD')
    expect(prettyCellType('$lut')).toBe('LUT')
  })
  it('keeps vendor primitives', () => {
    expect(prettyCellType('SB_LUT4')).toBe('SB_LUT4')
  })
})

describe('isHiddenName', () => {
  it('flags $-prefixed and empty names', () => {
    expect(isHiddenName('$abc$240$auto$blifparse.cc:397:parse_blif$242')).toBe(true)
    expect(isHiddenName('$auto$ff.cc:266:slice$1354')).toBe(true)
    expect(isHiddenName('')).toBe(true)
    expect(isHiddenName(undefined)).toBe(true)
  })
  it('passes human names', () => {
    expect(isHiddenName('q_reg')).toBe(false)
    expect(isHiddenName('sum[3]')).toBe(false)
  })
})

describe('shortNetName', () => {
  it('takes the last $-segment of auto names', () => {
    expect(shortNetName('$abc$240$new_n27')).toBe('new_n27')
    expect(shortNetName('$auto$123')).toBe('123')
  })
  it('passes human names through', () => {
    expect(shortNetName('sum[3]')).toBe('sum[3]')
    expect(shortNetName('enable')).toBe('enable')
  })
})

describe('fanoutDriverLabel', () => {
  const cell = (name: string, cell_type: string, seq = false): NodeRef => ({
    id: 1,
    kind: 'cell',
    name,
    cell_type,
    seq: seq || undefined,
  })

  it('prettifies hidden comb cell names using the net', () => {
    const d = cell('$abc$240$auto$blifparse.cc:397:parse_blif$242', '$_NAND_')
    expect(fanoutDriverLabel(d, '$abc$240$new_n27')).toBe('NAND · new_n27')
  })

  it('never contains blifparse paths', () => {
    const d = cell('$abc$240$auto$blifparse.cc:397:parse_blif$242', '$_AOI4_')
    expect(fanoutDriverLabel(d, '$abc$240$new_n5')).not.toContain('blifparse')
  })

  it('keeps named comb cells as-is', () => {
    const d = cell('my_adder', '$add')
    expect(fanoutDriverLabel(d, '$auto$99')).toBe('my_adder')
  })

  it('keeps FF cells as-is (even hidden names)', () => {
    const d = cell('$auto$ff.cc:266:slice$1354', '$_SDFF_PP0_', true)
    expect(fanoutDriverLabel(d, 'q[0]')).toBe('$auto$ff.cc:266:slice$1354')
  })

  it('keeps port drivers as-is', () => {
    const port: NodeRef = { id: 2, kind: 'port', name: 'clk' }
    expect(fanoutDriverLabel(port, 'clk')).toBe('clk')
  })
})
