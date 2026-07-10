import { describe, expect, it } from 'vitest'
import {
  displayCellType,
  displayNodeName,
  fanoutDriverLabel,
  isHiddenName,
  nodeSublabel,
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

  it('hidden FF names fall back to the driven net (raw never shown)', () => {
    const d = cell('$auto$ff.cc:266:slice$1354', '$_SDFF_PP0_', true)
    expect(fanoutDriverLabel(d, 'q[0]')).toBe('q[0]')
  })

  it('named FF cells keep their name', () => {
    const d = cell('state_reg', '$_SDFF_PP0_', true)
    expect(fanoutDriverLabel(d, 'state[0]')).toBe('state_reg')
  })

  it('keeps port drivers as-is', () => {
    const port: NodeRef = { id: 2, kind: 'port', name: 'clk' }
    expect(fanoutDriverLabel(port, 'clk')).toBe('clk')
  })
})

describe('displayCellType', () => {
  it('renames gates for readability', () => {
    expect(displayCellType('$_AND_')).toBe('AND')
    expect(displayCellType('$_NAND_')).toBe('NAND')
    expect(displayCellType('$_XNOR_')).toBe('XNOR')
    expect(displayCellType('$_NOT_')).toBe('NOT')
    expect(displayCellType('$_MUX_')).toBe('MUX')
    expect(displayCellType('$_NMUX_')).toBe('NMUX')
    expect(displayCellType('$_MUX16_')).toBe('MUX16')
    expect(displayCellType('$_AOI3_')).toBe('AOI3')
    expect(displayCellType('$_OAI4_')).toBe('OAI4')
    expect(displayCellType('$_ANDNOT_')).toBe('AND-NOT')
    expect(displayCellType('$_ORNOT_')).toBe('OR-NOT')
  })

  it('decodes hard FF types', () => {
    expect(displayCellType('$_DFF_P_')).toBe('DFF')
    expect(displayCellType('$_DFF_N_')).toBe('DFF ↓clk')
    expect(displayCellType('$_SDFF_PP0_')).toBe('DFF (rst→0)')
    expect(displayCellType('$_SDFF_PP1_')).toBe('DFF (rst→1)')
    expect(displayCellType('$_SDFF_NP0_')).toBe('DFF (rst→0) ↓clk')
    expect(displayCellType('$_SDFFE_PP0P_')).toBe('DFF (rst→0, en)')
    expect(displayCellType('$_SDFFCE_PP0P_')).toBe('DFF (rst→0, en)')
    expect(displayCellType('$_DFFE_PP_')).toBe('DFF (en)')
    expect(displayCellType('$_DFFE_NP_')).toBe('DFF (en) ↓clk')
    expect(displayCellType('$_DFF_PP0_')).toBe('DFF (arst→0)')
    expect(displayCellType('$_DFFE_PP1P_')).toBe('DFF (arst→1, en)')
    expect(displayCellType('$_ALDFF_PP_')).toBe('DFF (aload)')
    expect(displayCellType('$_DFFSR_PPP_')).toBe('DFF (set/rst)')
    expect(displayCellType('$_DFFSRE_PPPP_')).toBe('DFF (set/rst, en)')
    expect(displayCellType('$_FF_')).toBe('FF')
  })

  it('decodes latches and SR', () => {
    expect(displayCellType('$_DLATCH_P_')).toBe('LATCH')
    expect(displayCellType('$_DLATCH_PP0_')).toBe('LATCH (rst→0)')
    expect(displayCellType('$_DLATCHSR_PPP_')).toBe('LATCH (set/rst)')
    expect(displayCellType('$_SR_PP_')).toBe('SR')
  })

  it('decodes word-level FF types the same way', () => {
    expect(displayCellType('$dff')).toBe('DFF')
    expect(displayCellType('$dffe')).toBe('DFF (en)')
    expect(displayCellType('$sdff')).toBe('DFF (rst)')
    expect(displayCellType('$sdffe')).toBe('DFF (rst, en)')
    expect(displayCellType('$adff')).toBe('DFF (arst)')
    expect(displayCellType('$aldff')).toBe('DFF (aload)')
    expect(displayCellType('$dffsr')).toBe('DFF (set/rst)')
    expect(displayCellType('$dlatch')).toBe('LATCH')
  })

  it('folds LUT width from params', () => {
    expect(displayCellType('$lut', { LUT: '1010', WIDTH: '4' })).toBe('LUT4')
    expect(displayCellType('$lut', { WIDTH: '6' })).toBe('LUT6')
    expect(displayCellType('$lut')).toBe('LUT')
  })

  it('uppercases other word-level cells', () => {
    expect(displayCellType('$add')).toBe('ADD')
    expect(displayCellType('$mux')).toBe('MUX')
    expect(displayCellType('$eq')).toBe('EQ')
  })

  it('passes vendor primitives through unchanged', () => {
    expect(displayCellType('LUT4')).toBe('LUT4')
    expect(displayCellType('FDRE')).toBe('FDRE')
    expect(displayCellType('SB_LUT4')).toBe('SB_LUT4')
    expect(displayCellType('CARRY4')).toBe('CARRY4')
    expect(displayCellType('OBUF')).toBe('OBUF')
    expect(displayCellType('TRELLIS_FF')).toBe('TRELLIS_FF')
  })

  it('handles missing type', () => {
    expect(displayCellType(undefined)).toBe('?')
  })
})

describe('displayNodeName', () => {
  it('passes human names through', () => {
    const n: NodeRef = { id: 1, kind: 'cell', name: 'q_reg', cell_type: '$_DFF_P_' }
    expect(displayNodeName(n)).toBe('q_reg')
  })

  it('uses the shortened driving net for hidden names', () => {
    const n: NodeRef = {
      id: 1,
      kind: 'cell',
      name: '$abc$607$auto$blifparse.cc:397:parse_blif$609',
      cell_type: '$lut',
    }
    expect(displayNodeName(n, '$abc$607$new_n42')).toBe('new_n42')
  })

  it('falls back to the pretty type when no net is known', () => {
    const n: NodeRef = {
      id: 1,
      kind: 'cell',
      name: '$auto$ff.cc:266:slice$1354',
      cell_type: '$_SDFF_PP0_',
      seq: true,
    }
    expect(displayNodeName(n)).toBe('DFF (rst→0)')
  })

  it('never yields a blifparse path', () => {
    const n: NodeRef = {
      id: 1,
      kind: 'cell',
      name: '$abc$607$auto$blifparse.cc:397:parse_blif$609',
      cell_type: '$_NAND_',
    }
    expect(displayNodeName(n)).not.toContain('blifparse')
    expect(displayNodeName(n, '$abc$607$new_n1')).not.toContain('blifparse')
  })
})

describe('nodeSublabel', () => {
  const cell = (name: string): NodeRef => ({
    id: 1,
    kind: 'cell',
    name,
    cell_type: '$_NAND_',
  })

  it('keeps real cell names', () => {
    expect(nodeSublabel(cell('my_adder'), '$abc$240$new_n27')).toBe('my_adder')
  })

  it('replaces hidden names with the shortened driving net', () => {
    expect(
      nodeSublabel(
        cell('$abc$240$auto$blifparse.cc:397:parse_blif$242'),
        '$abc$240$new_n27',
      ),
    ).toBe('new_n27')
  })

  it('never returns a blifparse path', () => {
    const sub = nodeSublabel(
      cell('$abc$240$auto$blifparse.cc:397:parse_blif$242'),
      '$abc$240$new_n5',
    )
    expect(sub).not.toContain('blifparse')
  })

  it('suppresses hidden names when no driving net is known', () => {
    expect(
      nodeSublabel(cell('$abc$240$auto$blifparse.cc:397:parse_blif$242')),
    ).toBeNull()
    expect(
      nodeSublabel(cell('$abc$240$auto$blifparse.cc:397:parse_blif$242'), null),
    ).toBeNull()
  })

  it('returns null for ports and consts', () => {
    const port: NodeRef = { id: 2, kind: 'port', name: 'clk' }
    const konst: NodeRef = { id: 3, kind: 'const', name: "1'b0" }
    expect(nodeSublabel(port, 'clk')).toBeNull()
    expect(nodeSublabel(konst)).toBeNull()
  })
})
