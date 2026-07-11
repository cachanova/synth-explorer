// Pretty-printing of yosys cell type names for node labels.

import type { GraphNode, NodeRef } from '../types'

/** LUT width from params (WIDTH), if present. */
export function lutWidth(params: Record<string, string> | undefined): number | null {
  if (!params) return null
  const w = params.WIDTH ?? params.width
  if (w == null) return null
  const n = Number(w)
  return Number.isFinite(n) ? n : null
}

// Gate primitives whose stripped name benefits from extra punctuation.
const GATE_DISPLAY: Record<string, string> = {
  ANDNOT: 'AND-NOT',
  ORNOT: 'OR-NOT',
}

/**
 * Decode a yosys hard-cell FF/latch type ("$_SDFF_PP0_" style) given its
 * family ("SDFF") and flag chars ("PP0"). Returns null for non-FF families.
 * Flag encodings (yosys simcells): first char = clock polarity (P/N), then
 * reset/set polarity + reset value, and finally enable polarity where
 * applicable. Only non-default (negedge) clock polarity is surfaced.
 */
function decodeHardFF(family: string, flags: string): string | null {
  const parts: string[] = []
  let clocked = true
  let base = 'DFF'

  switch (family) {
    case 'FF':
      return 'FF'
    case 'DFF':
      if (flags.length === 3) parts.push(`arst→${flags[2]}`)
      break
    case 'DFFE':
      if (flags.length === 2) parts.push('en')
      else if (flags.length === 4) parts.push(`arst→${flags[2]}`, 'en')
      break
    case 'SDFF':
      if (flags.length === 3) parts.push(`rst→${flags[2]}`)
      break
    case 'SDFFE':
    case 'SDFFCE':
      if (flags.length === 4) parts.push(`rst→${flags[2]}`, 'en')
      break
    case 'ALDFF':
      parts.push('aload')
      if (flags.length === 3) parts.push('en')
      break
    case 'ALDFFE':
      parts.push('aload', 'en')
      break
    case 'DFFSR':
      parts.push('set/rst')
      break
    case 'DFFSRE':
      parts.push('set/rst', 'en')
      break
    case 'DLATCH':
      base = 'LATCH'
      clocked = false
      if (flags.length === 3) parts.push(`rst→${flags[2]}`)
      break
    case 'DLATCHSR':
      base = 'LATCH'
      clocked = false
      parts.push('set/rst')
      break
    case 'SR':
      return 'SR'
    default:
      return null
  }

  let out = base
  if (parts.length > 0) out += ` (${parts.join(', ')})`
  if (clocked && flags[0] === 'N') out += ' ↓clk'
  return out
}

// Word-level sequential cells ($sdff etc. — reset value lives in params, so
// no →V decode here).
const WORD_SEQ: Record<string, string> = {
  ff: 'FF',
  dff: 'DFF',
  dffe: 'DFF (en)',
  sdff: 'DFF (rst)',
  sdffe: 'DFF (rst, en)',
  sdffce: 'DFF (rst, en)',
  adff: 'DFF (arst)',
  adffe: 'DFF (arst, en)',
  aldff: 'DFF (aload)',
  aldffe: 'DFF (aload, en)',
  dffsr: 'DFF (set/rst)',
  dffsre: 'DFF (set/rst, en)',
  dlatch: 'LATCH',
  adlatch: 'LATCH (arst)',
  dlatchsr: 'LATCH (set/rst)',
  sr: 'SR',
}

/**
 * Human display name for a yosys cell type — the single source of truth for
 * every user-visible surface. The raw type belongs in a title tooltip next to
 * wherever this is rendered.
 *
 *   "$_ANDNOT_"     -> "AND-NOT"
 *   "$_SDFF_PP0_"   -> "DFF (rst→0)"
 *   "$_SDFFE_NP0P_" -> "DFF (rst→0, en) ↓clk"
 *   "$lut" + WIDTH  -> "LUT4"
 *   "$add"          -> "ADD"
 *   "FDRE"/"SB_LUT4"-> unchanged (vendor names are already meaningful)
 */
export function displayCellType(
  cellType: string | undefined,
  params?: Record<string, string>,
): string {
  if (!cellType) return '?'
  // Vendor primitives (LUT4, FDRE, SB_LUT4, CARRY4, OBUF, TRELLIS_FF, ...)
  // pass through unchanged.
  if (!cellType.startsWith('$')) return cellType

  if (cellType.startsWith('$_') && cellType.endsWith('_')) {
    const inner = cellType.slice(2, -1)
    const us = inner.indexOf('_')
    const family = us === -1 ? inner : inner.slice(0, us)
    const flags = us === -1 ? '' : inner.slice(us + 1)
    const ff = decodeHardFF(family, flags)
    if (ff) return ff
    return GATE_DISPLAY[inner] ?? inner // AND, NAND, XNOR, MUX16, AOI3, ...
  }

  const t = cellType.slice(1).toLowerCase()
  if (t === 'lut') {
    const w = lutWidth(params)
    return w != null ? `LUT${w}` : 'LUT'
  }
  const seq = WORD_SEQ[t]
  if (seq) return seq
  return t.toUpperCase() // $add -> ADD, $mux -> MUX, ...
}

/**
 * Full node label: ports and consts use their name; cells use the human
 * cell-type display (LUT width folded in from params).
 */
export function nodeLabel(node: GraphNode | NodeRef): string {
  if (node.kind === 'port') return node.name
  if (node.kind === 'const') return node.name
  return displayCellType(node.cell_type, (node as GraphNode).params)
}

/** Category used for styling. */
export type NodeCategory = 'input' | 'output' | 'const' | 'seq' | 'comb'

export function nodeCategory(
  node: GraphNode | NodeRef,
  portDir?: 'input' | 'output',
): NodeCategory {
  if (node.kind === 'const') return 'const'
  if (node.kind === 'port') {
    // direction may be encoded elsewhere; default to output if unknown
    return portDir ?? 'output'
  }
  if (node.seq) return 'seq'
  return 'comb'
}

const SEQ_HINT = /dff|latch|ff|mem|sr|reg/i

/** Best-effort seq detection when the seq flag is missing. */
export function looksSequential(cellType: string | undefined): boolean {
  if (!cellType) return false
  return SEQ_HINT.test(cellType)
}

/** True for yosys auto-generated / hidden names ("$abc$240$auto$blifparse..."). */
export function isHiddenName(name: string | undefined): boolean {
  return !name || name.startsWith('$')
}

/**
 * Shorten an auto-generated net name to its last meaningful segment:
 *   "$abc$240$new_n27"  -> "new_n27"
 *   "$auto$123"         -> "123"
 *   "sum[3]"            -> "sum[3]" (human names pass through)
 */
export function shortNetName(net: string): string {
  if (!net.startsWith('$')) return net
  const segs = net.split('$').filter((s) => s.length > 0)
  if (segs.length === 0) return net
  // Drop path-like segments ("auto$blifparse.cc:397:parse_blif") entirely;
  // the last segment is the local identity.
  return segs[segs.length - 1]
}

/**
 * Primary display label for a fanout driver. Comb cells with hidden names
 * show "TYPE · shortNet" (e.g. "NAND · new_n27") instead of unreadable ABC
 * names; ports/FFs/named cells keep their own name.
 */
export function fanoutDriverLabel(driver: NodeRef, netName: string): string {
  if (driver.kind === 'cell' && !driver.seq && isHiddenName(driver.name)) {
    return `${displayCellType(driver.cell_type)} · ${shortNetName(netName)}`
  }
  // Hidden FF/port names fall back to the (short) net name they drive.
  return displayNodeName(driver, netName)
}

/**
 * Display name for a node anywhere in the UI. Human names pass through;
 * hidden ($-prefixed) names become the shortened driving-net name when one
 * is known, otherwise the human cell-type display. Raw hidden names must
 * never reach the DOM.
 */
export function displayNodeName(node: NodeRef, drivingNet?: string | null): string {
  if (!isHiddenName(node.name)) return node.name
  if (drivingNet) {
    const short = shortNetName(drivingNet)
    if (short) return short
  }
  if (node.kind === 'cell') return displayCellType(node.cell_type)
  return shortNetName(node.name)
}

/**
 * Secondary label shown under a cell's type label in the graph view. Real
 * names pass through; hidden yosys/ABC names are replaced by the shortened
 * driving-net name (e.g. "new_n27") or suppressed when no net is known.
 */
export function nodeSublabel(
  node: NodeRef,
  drivingNet?: string | null,
): string | null {
  if (node.kind !== 'cell' || !node.name) return null
  if (!isHiddenName(node.name)) return node.name
  if (drivingNet) {
    const short = shortNetName(drivingNet)
    return short || null
  }
  return null
}
