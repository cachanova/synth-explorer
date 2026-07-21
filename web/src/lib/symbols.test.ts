import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, NodeRef } from '../types'
import {
  arithGlyph,
  boxBadge,
  bubbleAt,
  controlLabel,
  controlsFor,
  inferPortDirection,
  inferPortDirections,
  inputBubbleAt,
  isSpecialPrimitive,
  shapePath,
  symbolKind,
} from './symbols'

const cell = (cell_type: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id: 1,
  kind: 'cell',
  name: 'u0',
  cell_type,
  ...extra,
})

describe('symbolKind', () => {
  it.each([
    ['$_AND_', 'and'],
    ['$_ANDNOT_', 'and'],
    ['$_NAND_', 'nand'],
    ['$_OR_', 'or'],
    ['$_ORNOT_', 'or'],
    ['$_NOR_', 'nor'],
    ['$_XOR_', 'xor'],
    ['$_XNOR_', 'xnor'],
    ['$_NOT_', 'not'],
    ['$_BUF_', 'buf'],
    ['$mux', 'mux'],
    ['$_MUX16_', 'mux'],
    ['$_NMUX_', 'nmux'],
  ] as const)('maps %s to a standard %s symbol', (cellType, expected) => {
    expect(symbolKind(cell(cellType))).toBe(expected)
  })

  it('recognises sequential cells from flags and vendor names', () => {
    expect(symbolKind(cell('$dff', { seq: true }))).toBe('reg')
    expect(symbolKind(cell('$_SDFF_PP0_'))).toBe('reg')
    expect(symbolKind(cell('$aldffe'))).toBe('reg')
    expect(symbolKind(cell('$dlatch', { register: true, seq: true }))).toBe('latch')
    expect(symbolKind(cell('LDCE', { register: true, seq: true }))).toBe('latch')
    expect(symbolKind(cell('FDRE'))).toBe('reg')
    expect(symbolKind(cell('FDR'))).toBe('reg')
    expect(symbolKind(cell('SRL16E', { register: false, seq: true }))).toBe('memory')
    expect(symbolKind(cell('SB_DFFESR'))).toBe('reg')
    expect(symbolKind(cell('TRELLIS_FF'))).toBe('reg')
  })

  it('recognises LUT, arithmetic, memory, and fallback boundary boxes', () => {
    expect(symbolKind(cell('$lut'))).toBe('lut')
    expect(symbolKind(cell('SB_LUT4'))).toBe('lut')
    expect(symbolKind(cell('TRELLIS_COMB'))).toBe('lut')
    expect(symbolKind(cell('SB_GB'))).toBe('buf')
    expect(symbolKind(cell('$add'))).toBe('arith')
    expect(symbolKind(cell('$mem_v2'))).toBe('memory')
    expect(symbolKind(cell('RAM32M'))).toBe('memory')
    expect(symbolKind(cell('RAMB36E2'))).toBe('memory')
    expect(symbolKind(cell('CARRY4', { is_boundary: true }))).toBe('carry')
    expect(symbolKind(cell('CARRY8'))).toBe('carry')
    expect(symbolKind(cell('SB_CARRY'))).toBe('carry')
    expect(symbolKind(cell('CCU2C'))).toBe('carry')
    expect(symbolKind(cell('DSP48E2'))).toBe('dsp')
    expect(symbolKind(cell('MULT18X18D'))).toBe('dsp')
    expect(symbolKind(cell('SB_MAC16'))).toBe('dsp')
    expect(symbolKind(cell('mystery', { seq: true, is_boundary: true }))).toBe('box')
  })

  it('maps vendor carry-adjacent logic to the matching standard symbol', () => {
    expect(symbolKind(cell('MUXCY'))).toBe('mux')
    expect(symbolKind(cell('MUXF8'))).toBe('mux')
    expect(symbolKind(cell('XORCY'))).toBe('xor')
  })

  it('identifies vendor-specific implementation primitives', () => {
    for (const primitive of [
      'CARRY4', 'SB_LUT4', 'TRELLIS_COMB', 'IBUF', 'LUT6', 'XORCY', 'MUXCY', 'INV',
      'DSP48E2', 'MULT18X18D', 'SB_MAC16',
    ]) {
      expect(isSpecialPrimitive(cell(primitive)), primitive).toBe(true)
    }
    expect(isSpecialPrimitive(cell('$add'))).toBe(false)
    expect(isSpecialPrimitive(cell('mystery'))).toBe(false)
  })

  it('does not classify unrelated RAM-prefixed cells as memories', () => {
    expect(symbolKind(cell('ramp_generator'))).toBe('box')
  })

  it('recognizes memory primitives across supported synthesis families', () => {
    for (const primitive of [
      '$mem_v2', 'RAM32M', 'RAMD32', 'RAMS64E', 'RAMB36E2', 'URAM288', 'DP16KD', 'SB_RAM40_4K',
      'SB_SPRAM256KA',
    ]) {
      expect(symbolKind(cell(primitive)), primitive).toBe('memory')
    }
  })

  it('keeps the base symbol for grouped vector nodes', () => {
    // A grouped node carries width/members but still draws as its base kind.
    expect(symbolKind(cell('FDRE', { width: 8, members: [1, 2, 3] }))).toBe('reg')
    expect(symbolKind(cell('$lut', { width: 4, members: [1, 2] }))).toBe('lut')
    expect(symbolKind(cell('$mux', { width: 8, members: [1, 2] }))).toBe('mux')
  })

  it('uses directional symbols for top-level ports', () => {
    const port: NodeRef = { id: 7, kind: 'port', name: 'valid' }
    expect(symbolKind(port, 'input')).toBe('port-in')
    expect(symbolKind(port, 'output')).toBe('port-out')
  })
})

describe('symbol geometry', () => {
  it('builds non-empty outlines for gate, mux, and port symbols', () => {
    for (const kind of [
      'and',
      'or',
      'xor',
      'not',
      'buf',
      'mux',
      'port-in',
      'port-out',
      'carry',
      'dsp',
    ] as const) {
      expect(shapePath(kind, 72, 48)).toMatch(/^M /)
    }
  })

  it('uses primitive-family badges for hard blocks', () => {
    expect(boxBadge(cell('CARRY8'))).toBe('CARRY')
    expect(boxBadge(cell('DSP48E2'))).toBe('DSP')
    expect(boxBadge(cell('RAMB36E2'))).toBe('MEM')
  })

  it('places output bubbles on inverted symbols', () => {
    expect(bubbleAt('nand', 72, 48)).toEqual({ cx: 68, cy: 24, r: 4 })
    expect(bubbleAt('nmux', 72, 48)).toEqual({ cx: 68, cy: 24, r: 4 })
    expect(bubbleAt('and', 72, 48)).toBeNull()
  })

  it('marks the inverted input on ANDNOT and ORNOT cells', () => {
    expect(inputBubbleAt(cell('$_ANDNOT_'), 72, 48)).toEqual({ cx: 4, cy: 32, r: 4 })
    expect(inputBubbleAt(cell('$_ORNOT_'), 72, 48)).toEqual({ cx: 4, cy: 32, r: 4 })
    expect(inputBubbleAt(cell('$_AND_'), 72, 48)).toBeNull()
  })
})

describe('graph topology helpers', () => {
  const edge = (from: number, to: number): GraphEdge => ({
    from,
    to,
    from_port: 'Y',
    to_port: 'A',
    net_name: 'n',
    bits: [1],
  })

  it('infers input and output port direction from signal flow', () => {
    expect(inferPortDirection(1, [edge(1, 2)])).toBe('input')
    expect(inferPortDirection(2, [edge(1, 2)])).toBe('output')
  })

  it('prefers output for a terminal or ambiguous port', () => {
    expect(inferPortDirection(3, [])).toBe('output')
    expect(inferPortDirection(2, [edge(1, 2), edge(2, 3)])).toBe('output')
  })

  it('infers many port directions in one edge pass', () => {
    expect(inferPortDirections([1, 2, 3], [edge(1, 2), edge(2, 3)])).toEqual(
      new Map([
        [1, 'input'],
        [2, 'output'],
        [3, 'output'],
      ]),
    )
  })
})

describe('operator and control labels', () => {
  it('uses compact arithmetic glyphs', () => {
    expect(arithGlyph('$add')).toBe('+')
    expect(arithGlyph('$sshr')).toBe('≫')
    expect(arithGlyph('CARRY4')).toBeNull()
  })

  it('reads controls from the typed graph contract', () => {
    const n = cell('FDRE')
    n.controls = [
      { role: 'clock', pin: 'C', net_name: 'sys_clk', driver_id: 4, fanout: 2 },
      {
        role: 'reset',
        pin: 'R',
        net_name: 'rst_n',
        driver_id: 5,
        fanout: 2,
        generated: true,
      },
    ]
    expect(controlsFor(n)).toEqual(n.controls)
    expect(controlLabel(n.controls[0])).toBe('CLK sys_clk')
    expect(controlLabel(n.controls[1])).toBe('RST rst_n')
  })
})
