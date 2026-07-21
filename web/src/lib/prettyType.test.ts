import { describe, expect, it } from 'vitest'
import {
  displayCellType,
  displayNodeName,
  fanoutDriverLabel,
  groupBadgeText,
  isHiddenName,
  nodeSublabel,
  shortNetName,
} from './prettyType'
import type { GraphNode, NodeRef } from '../types'

describe('groupBadgeText', () => {
  const grouped = (over: Partial<GraphNode>): GraphNode => ({
    id: 1,
    kind: 'cell',
    name: 'n',
    width: 8,
    ...over,
  })

  it('returns null for ungrouped nodes', () => {
    expect(groupBadgeText({ id: 1, kind: 'cell', name: 'foo' })).toBeNull()
    expect(groupBadgeText(grouped({ width: 1 }))).toBeNull()
  })

  it('suppresses the badge when the label already shows a bit range', () => {
    // port label is the name itself
    expect(groupBadgeText(grouped({ kind: 'port', name: 'a[7:0]' }))).toBeNull()
    // reg: cell-type label is "DFF" but the register name carries the range
    expect(groupBadgeText(grouped({ cell_type: '$_DFF_P_', name: 'q[7:0]' }))).toBeNull()
  })

  it('suppresses the badge when the name already shows a ×N count', () => {
    expect(groupBadgeText(grouped({ cell_type: '$mux', name: 'sel ×3' }))).toBeNull()
  })

  it('keeps ×N when the visible text carries no width (hidden vector name)', () => {
    expect(groupBadgeText(grouped({ cell_type: '$_AND_', name: '$_AND_ ×8' }))).toBe('×8')
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
  })
  it('passes human names through', () => {
    expect(shortNetName('sum[3]')).toBe('sum[3]')
    expect(shortNetName('enable')).toBe('enable')
  })
  it('strips bare autoindex prefixes from the shortened segment', () => {
    expect(shortNetName('$flatten$abc$1866.genblk1.acc[3]')).toBe(
      'genblk1.acc[3]',
    )
    expect(shortNetName('$abc$9$3763.A[4]')).toBe('A[4]')
    expect(shortNetName('$auto$x$12/34/new_n7')).toBe('new_n7')
  })
  it('returns the empty string when only autoindex numbers remain', () => {
    expect(shortNetName('$auto$123')).toBe('')
    expect(shortNetName('$procdff$3763')).toBe('')
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

  it('drops the net suffix when the net shortens to nothing', () => {
    const d = cell('$abc$240$auto$blifparse.cc:397:parse_blif$242', '$_NAND_')
    expect(fanoutDriverLabel(d, '$auto$123')).toBe('NAND')
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
    // Reset/set/enable/value details are shown by the box pins, not the label.
    expect(displayCellType('$_SDFF_PP0_')).toBe('DFF')
    expect(displayCellType('$_SDFF_PP1_')).toBe('DFF')
    expect(displayCellType('$_SDFF_NP0_')).toBe('DFF ↓clk')
    expect(displayCellType('$_SDFFE_PP0P_')).toBe('DFF')
    expect(displayCellType('$_SDFFCE_PP0P_')).toBe('DFF')
    expect(displayCellType('$_DFFE_PP_')).toBe('DFF')
    expect(displayCellType('$_DFFE_NP_')).toBe('DFF ↓clk')
    expect(displayCellType('$_DFF_PP0_')).toBe('DFF')
    expect(displayCellType('$_DFFE_PP1P_')).toBe('DFF')
    expect(displayCellType('$_ALDFF_PP_')).toBe('DFF (aload)')
    expect(displayCellType('$_DFFSR_PPP_')).toBe('DFF')
    expect(displayCellType('$_DFFSRE_PPPP_')).toBe('DFF')
    expect(displayCellType('$_FF_')).toBe('FF')
  })

  it('decodes latches and SR', () => {
    expect(displayCellType('$_DLATCH_P_')).toBe('LATCH')
    expect(displayCellType('$_DLATCH_PP0_')).toBe('LATCH')
    expect(displayCellType('$_DLATCHSR_PPP_')).toBe('LATCH')
    expect(displayCellType('$_SR_PP_')).toBe('SR')
  })

  it('decodes word-level FF types the same way', () => {
    expect(displayCellType('$dff')).toBe('DFF')
    expect(displayCellType('$dffe')).toBe('DFF')
    expect(displayCellType('$sdff')).toBe('DFF')
    expect(displayCellType('$sdffe')).toBe('DFF')
    expect(displayCellType('$adff')).toBe('DFF')
    expect(displayCellType('$aldff')).toBe('DFF (aload)')
    expect(displayCellType('$dffsr')).toBe('DFF')
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
    expect(displayNodeName(n)).toBe('DFF')
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
    expect(nodeSublabel(cell('my_adder'))).toBe('my_adder')
  })

  it('suppresses hidden Yosys/ABC cell names', () => {
    expect(
      nodeSublabel(cell('$abc$240$auto$blifparse.cc:397:parse_blif$242')),
    ).toBeNull()
  })

  it('reduces Vivado implementation names to their RTL-facing signal', () => {
    expect(nodeSublabel({
      id: 2,
      kind: 'cell',
      name: 'one_hot_OBUF[23]_inst_i_6_2',
      cell_type: 'LUT1',
    })).toBe('one_hot[23]')
    expect(nodeSublabel({
      id: 3,
      kind: 'cell',
      name: 'valid_OBUF_inst_i_1',
      cell_type: 'LUT2',
    })).toBe('valid')
  })

  it('does not rewrite a similarly named non-Vivado cell', () => {
    expect(nodeSublabel({
      id: 4,
      kind: 'cell',
      name: 'valid_OBUF_inst_i_1',
      cell_type: 'my_output_stage',
    })).toBe('valid_OBUF_inst_i_1')
  })

  it('reduces a grouped fallback name to its count', () => {
    const grouped: GraphNode = {
      id: 2,
      kind: 'cell',
      name: 'LUT2 ×3',
      cell_type: 'LUT2',
      width: 3,
    }
    expect(nodeSublabel(grouped)).toBe('×3')
  })

  it('keeps a real name that only resembles a grouped fallback', () => {
    expect(nodeSublabel({
      id: 2,
      kind: 'cell',
      name: 'LUT2 ×3',
      cell_type: 'LUT2',
    })).toBe('LUT2 ×3')
  })

  it('returns null for ports and consts', () => {
    const port: NodeRef = { id: 2, kind: 'port', name: 'clk' }
    const konst: NodeRef = { id: 3, kind: 'const', name: "1'b0" }
    expect(nodeSublabel(port)).toBeNull()
    expect(nodeSublabel(konst)).toBeNull()
  })
})
