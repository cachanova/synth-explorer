import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, NodeRef } from '../types'
import {
  arithGlyph,
  bubbleAt,
  controlLabel,
  controlsFor,
  inferPortDirection,
  inputBubbleAt,
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
    expect(symbolKind(cell('FDRE'))).toBe('reg')
    expect(symbolKind(cell('FDR'))).toBe('reg')
    expect(symbolKind(cell('SRL16E'))).toBe('reg')
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
    expect(symbolKind(cell('RAMB36E2'))).toBe('memory')
    expect(symbolKind(cell('CARRY4', { is_boundary: true }))).toBe('box')
    expect(symbolKind(cell('mystery', { seq: true, is_boundary: true }))).toBe('box')
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
    ] as const) {
      expect(shapePath(kind, 72, 48)).toMatch(/^M /)
    }
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
})

describe('operator and control labels', () => {
  it('uses compact arithmetic glyphs', () => {
    expect(arithGlyph('$add')).toBe('+')
    expect(arithGlyph('$sshr')).toBe('≫')
    expect(arithGlyph('CARRY4')).toBeNull()
  })

  it('reads a future controls array without requiring the graph type yet', () => {
    const n = cell('FDRE') as GraphNode & {
      controls: Array<{ role: string; net_name: string; driver_id: number; generated?: boolean }>
    }
    n.controls = [
      { role: 'clock', net_name: 'sys_clk', driver_id: 4 },
      { role: 'reset', net_name: 'rst_n', driver_id: 5, generated: true },
    ]
    expect(controlsFor(n)).toEqual(n.controls)
    expect(controlLabel(n.controls[0])).toBe('CLK sys_clk')
    expect(controlLabel(n.controls[1])).toBe('RST rst_n')
  })

  it('ignores malformed future control metadata', () => {
    const n = cell('FDRE') as GraphNode & { controls: unknown }
    n.controls = [{ role: 'clock', net_name: 3, driver_id: 'bad' }]
    expect(controlsFor(n)).toEqual([])
  })
})
