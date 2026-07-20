// Pure schematic-symbol classification and geometry. GraphView owns React
// rendering; keeping these helpers DOM-free makes the visual vocabulary easy
// to verify without snapshots of generated SVG path strings.

import type { ControlRef, GraphEdge, GraphNode, NodeRef } from '../types'
import { shortNetName } from './prettyType'

export type PortDirection = 'input' | 'output'

export type SymbolKind =
  | 'and'
  | 'nand'
  | 'or'
  | 'nor'
  | 'xor'
  | 'xnor'
  | 'not'
  | 'buf'
  | 'mux'
  | 'nmux'
  | 'reg'
  | 'latch'
  | 'lut'
  | 'arith'
  | 'memory'
  | 'port-in'
  | 'port-out'
  | 'const'
  | 'box'

export function controlsFor(node: GraphNode): ControlRef[] {
  return node.controls ?? []
}

/** A compact conventional net-label caption, never a raw ABC/Yosys path. */
export function controlLabel(control: ControlRef): string {
  const role = control.role.toLowerCase()
  const prefix = role === 'clock' || role === 'clk'
    ? 'CLK'
    : role === 'reset' || role === 'rst'
      ? 'RST'
      : role === 'enable' || role === 'en' || role === 'ce'
        ? 'EN'
        : control.role.toUpperCase()
  const polarity = control.active_low ? '↓' : ''
  return `${prefix}${polarity} ${shortNetName(control.net_name)}`
}

/** Infer a top-level port's data direction from the graph topology. */
export function inferPortDirection(
  nodeId: number,
  edges: readonly Pick<GraphEdge, 'from' | 'to'>[],
): PortDirection {
  let drives = false
  let isDriven = false
  for (const edge of edges) {
    if (edge.from === nodeId) drives = true
    if (edge.to === nodeId) isDriven = true
  }
  // A pure source is an input. Terminal and unusual bidirectional nodes are
  // rendered as outputs, which is the safer endpoint-oriented default.
  return drives && !isDriven ? 'input' : 'output'
}

/** Infer many top-level port directions in one O(nodes + edges) pass. */
export function inferPortDirections(
  nodeIds: Iterable<number>,
  edges: readonly Pick<GraphEdge, 'from' | 'to'>[],
): Map<number, PortDirection> {
  const ports = new Set(nodeIds)
  const drives = new Set<number>()
  const driven = new Set<number>()
  for (const edge of edges) {
    if (ports.has(edge.from)) drives.add(edge.from)
    if (ports.has(edge.to)) driven.add(edge.to)
  }
  return new Map(
    [...ports].map((id) => [
      id,
      drives.has(id) && !driven.has(id) ? 'input' : 'output',
    ]),
  )
}

function canonicalCellType(cellType: string): string {
  if (cellType.startsWith('$_') && cellType.endsWith('_')) {
    return cellType.slice(2, -1).toUpperCase()
  }
  return (cellType.startsWith('$') ? cellType.slice(1) : cellType).toUpperCase()
}

const MUX_TYPES = new Set([
  'MUX',
  'PMUX',
  'TERNARY',
  'TRIBUF',
  'PFUMX',
  'L6MUX21',
  'MUXF7',
  'MUXF8',
  'MUXF9',
  'MUXCY',
])

const ARITH_GLYPHS: Record<string, string> = {
  ADD: '+',
  SUB: '−',
  NEG: '−',
  MUL: '×',
  MACC: '×',
  DIV: '÷',
  DIVFLOOR: '÷',
  MOD: '%',
  MODFLOOR: '%',
  POW: '^',
  EQ: '=',
  EQX: '=',
  NE: '≠',
  NEX: '≠',
  LT: '<',
  LE: '≤',
  GT: '>',
  GE: '≥',
  SHL: '≪',
  SSHL: '≪',
  SHR: '≫',
  SSHR: '≫',
  SHIFT: '≫',
  SHIFTX: '≫',
  REDUCE_AND: '&',
  REDUCE_OR: '≥1',
  REDUCE_XOR: '=1',
}

const MEMORY_HINT = /(?:^|_)(?:MEM(?:ORY|RD|WR|INIT)?|RAM|ROM)(?:_|$)|^(?:RAM(?:B|\d)|URAM|DP16KD|SPRAM|SB_(?:RAM|SPRAM)|SRL(?:16E|C32E))/i
const LATCH_HINT = /(?:^|_)(?:A?DLATCH(?:SR)?|SR)(?:_|$)|^LD(?:CE|PE|CPE)$/i
const REGISTER_HINT = /(?:^|_)(?:A?S?DFF(?:E|SR|SRE)?|ALDFF(?:E)?|FF)(?:_|$)|^FD(?:RE|CE|PE|SE|CPE|R|S|C|P)(?:_1)?$|^SB_DFF|^TRELLIS_FF$|^FL1P3/i
const LUT_HINT = /LUT\d*|^TRELLIS_COMB$/i
const SPECIAL_PRIMITIVE_HINT = /^(?:SB_|TRELLIS_|CCU2C|CARRY|MUXF[789]|MUXCY|XORCY|PFUMX|L6MUX21|LUT[1-6](?:_2)?|INV|RAM(?:B|\d)|URAM|DP16KD|SPRAM|SRL(?:16E|C32E)|FD|LD|IBUF|OBUF|IOBUF|BUFG|BUFH)/i

/** Vendor-specific implementation primitive, independent of its symbol shape. */
export function isSpecialPrimitive(node: NodeRef): boolean {
  return node.kind === 'cell' && SPECIAL_PRIMITIVE_HINT.test(canonicalCellType(node.cell_type ?? ''))
}

/** Map a graph node to a schematic archetype. */
export function symbolKind(
  node: NodeRef,
  portDirection: PortDirection = 'input',
): SymbolKind {
  if (node.kind === 'const') return 'const'
  if (node.kind === 'port') return portDirection === 'output' ? 'port-out' : 'port-in'

  const cellType = node.cell_type ?? ''
  if (!cellType) return 'box'
  const token = canonicalCellType(cellType)

  // Memory and unknown black-box boundaries can also carry seq=true. Keep
  // them as explicit boundaries rather than misrepresenting them as DFFs.
  if (MEMORY_HINT.test(token)) return 'memory'
  if (node.register !== false && LATCH_HINT.test(token)) return 'latch'
  if (node.register === true || (node.register !== false && REGISTER_HINT.test(token))) {
    return 'reg'
  }
  if (LUT_HINT.test(token)) return 'lut'
  if (MUX_TYPES.has(token) || /^MUX\d+$/.test(token)) return 'mux'
  if (/^NMUX\d*$/.test(token)) return 'nmux'

  switch (token) {
    case 'AND':
    case 'ANDNOT':
    case 'LOGIC_AND':
      return 'and'
    case 'NAND':
      return 'nand'
    case 'OR':
    case 'ORNOT':
    case 'LOGIC_OR':
      return 'or'
    case 'NOR':
      return 'nor'
    case 'XOR':
      return 'xor'
    case 'XNOR':
      return 'xnor'
    case 'NOT':
    case 'INV':
      return 'not'
    case 'BUF':
    case 'SB_GB':
      return 'buf'
  }

  if (token.includes('BUF')) return 'buf'
  if (token in ARITH_GLYPHS) return 'arith'
  return 'box'
}

export function arithGlyph(cellType: string | undefined): string | null {
  if (!cellType) return null
  return ARITH_GLYPHS[canonicalCellType(cellType)] ?? null
}

export function hasOutputBubble(kind: SymbolKind): boolean {
  return kind === 'nand' || kind === 'nor' || kind === 'xnor' || kind === 'not' || kind === 'nmux'
}

export function hasInputArc(kind: SymbolKind): boolean {
  return kind === 'xor' || kind === 'xnor'
}

const BUBBLE_R = 4

/**
 * Body outline in local node coordinates. Rectangle-based symbols return an
 * empty string and are drawn by GraphView.
 */
export function shapePath(kind: SymbolKind, width: number, height: number): string {
  const negated = hasOutputBubble(kind)
  const bodyWidth = negated ? width - BUBBLE_R * 2 : width
  const cy = height / 2

  switch (kind) {
    case 'and':
    case 'nand': {
      const straight = Math.max(0, bodyWidth - height / 2)
      return `M 0 0 L ${straight} 0 A ${height / 2} ${height / 2} 0 0 1 ${straight} ${height} L 0 ${height} Z`
    }
    case 'or':
    case 'nor':
    case 'xor':
    case 'xnor': {
      const back = bodyWidth * 0.16
      return (
        `M 0 0 Q ${back} ${cy} 0 ${height} ` +
        `Q ${bodyWidth * 0.62} ${height} ${bodyWidth} ${cy} ` +
        `Q ${bodyWidth * 0.62} 0 0 0 Z`
      )
    }
    case 'not':
    case 'buf':
      return `M 0 0 L ${bodyWidth} ${cy} L 0 ${height} Z`
    case 'mux':
    case 'nmux': {
      const inset = height * 0.18
      return `M 0 0 L ${bodyWidth} ${inset} L ${bodyWidth} ${height - inset} L 0 ${height} Z`
    }
    case 'port-in': {
      const tip = Math.min(height * 0.45, width * 0.35)
      return `M 0 0 L ${width - tip} 0 L ${width} ${cy} L ${width - tip} ${height} L 0 ${height} Z`
    }
    case 'port-out': {
      const tip = Math.min(height * 0.38, width * 0.3)
      return `M 0 0 L ${width - tip} 0 L ${width} ${cy} L ${width - tip} ${height} L 0 ${height} L ${tip} ${cy} Z`
    }
    default:
      return ''
  }
}

export function bubbleAt(
  kind: SymbolKind,
  width: number,
  height: number,
): { cx: number; cy: number; r: number } | null {
  if (!hasOutputBubble(kind)) return null
  const bodyWidth = width - BUBBLE_R * 2
  return { cx: bodyWidth + BUBBLE_R, cy: height / 2, r: BUBBLE_R }
}

export function inputArcPath(kind: SymbolKind, height: number): string | null {
  if (!hasInputArc(kind)) return null
  return `M -5 0 Q ${height * 0.16 - 5} ${height / 2} -5 ${height}`
}

/** ANDNOT/ORNOT invert their B-side input. */
export function inputBubbleAt(
  node: NodeRef,
  _width: number,
  height: number,
): { cx: number; cy: number; r: number } | null {
  const token = canonicalCellType(node.cell_type ?? '')
  if (token !== 'ANDNOT' && token !== 'ORNOT') return null
  return { cx: BUBBLE_R, cy: (height * 2) / 3, r: BUBBLE_R }
}

export function registerClockPath(height: number, yFraction = 0.72): string {
  const cy = height * yFraction
  return `M 0 ${cy - 6} L 7 ${cy} L 0 ${cy + 6}`
}

export function boxBadge(node: NodeRef): string {
  const kind = symbolKind(node)
  if (kind === 'memory') return 'MEM'
  if (isSpecialPrimitive(node)) return 'PRIM'
  return (node as GraphNode).is_boundary ? 'BOUNDARY' : 'CELL'
}
