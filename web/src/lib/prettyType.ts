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
  // Reset/set/enable/aload details are shown by the box's R/S/EN pins and the
  // control-label rows, so the type label is just the family word (plus a
  // negedge marker, which nothing else conveys). "aload" is the one feature
  // with no dedicated pin, so it stays.
  let clocked = true
  let base = 'DFF'
  let aload = false

  switch (family) {
    case 'FF':
      return 'FF'
    case 'DFF':
    case 'DFFE':
    case 'SDFF':
    case 'SDFFE':
    case 'SDFFCE':
    case 'DFFSR':
    case 'DFFSRE':
      break
    case 'ALDFF':
    case 'ALDFFE':
      aload = true
      break
    case 'DLATCH':
    case 'DLATCHSR':
      base = 'LATCH'
      clocked = false
      break
    case 'SR':
      return 'SR'
    default:
      return null
  }

  let out = base
  if (aload) out += ' (aload)'
  if (clocked && flags[0] === 'N') out += ' ↓clk'
  return out
}

// Word-level sequential cells ($sdff etc.). Reset/set/enable are shown by the
// box's R/S/EN pins, so the label is just the family word; "aload" (async load)
// has no pin and stays.
const WORD_SEQ: Record<string, string> = {
  ff: 'FF',
  dff: 'DFF',
  dffe: 'DFF',
  sdff: 'DFF',
  sdffe: 'DFF',
  sdffce: 'DFF',
  adff: 'DFF',
  adffe: 'DFF',
  aldff: 'DFF (aload)',
  aldffe: 'DFF (aload)',
  dffsr: 'DFF',
  dffsre: 'DFF',
  dlatch: 'LATCH',
  adlatch: 'LATCH',
  dlatchsr: 'LATCH',
  sr: 'SR',
}

/**
 * Human display name for a yosys cell type — the single source of truth for
 * every user-visible surface. The raw type belongs in a title tooltip next to
 * wherever this is rendered.
 *
 *   "$_ANDNOT_"     -> "AND-NOT"
 *   "$_SDFF_PP0_"   -> "DFF"
 *   "$_SDFFE_NP0P_" -> "DFF ↓clk"
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

/**
 * "×N" member-count badge for a grouped node, or null when the count is already
 * visible in the node's own label/name as a "[hi:lo]" range or trailing "×N".
 * A logical memory shape such as `[16×16]` is not a physical member count, so it
 * deliberately keeps the separate badge (`memory [16×16]`, `×4`).
 */
export function groupBadgeText(node: GraphNode | NodeRef): string | null {
  const graphNode = node as GraphNode
  const memberCount = graphNode.member_count ?? graphNode.width ?? 0
  if (memberCount < 2) return null
  const showsCount = (s: string) => /\[\d+:\d+\]/.test(s) || /×\d+\s*$/.test(s)
  if (showsCount(nodeLabel(node))) return null
  if (node.name && !isHiddenName(node.name) && showsCount(node.name)) return null
  return `×${memberCount}`
}

/** True for yosys auto-generated / hidden names ("$abc$240$auto$blifparse..."). */
export function isHiddenName(name: string | undefined): boolean {
  return !name || name.startsWith('$')
}

// Bare autoindex number at the start of a segment ("1866.genblk…", "3763").
const AUTOINDEX_PREFIX = /^\d+([./]|$)/

/**
 * Shorten an auto-generated net name to its last meaningful segment:
 *   "$abc$240$new_n27"    -> "new_n27"
 *   "$abc$9$3763.A[4]"    -> "A[4]"  (bare autoindex numbers are stripped)
 *   "$auto$123"           -> ""      (nothing meaningful — callers suppress)
 *   "sum[3]"              -> "sum[3]" (human names pass through)
 */
export function shortNetName(net: string): string {
  if (!net.startsWith('$')) return net
  const segs = net.split('$').filter((s) => s.length > 0)
  if (segs.length === 0) return net
  // Drop path-like segments ("auto$blifparse.cc:397:parse_blif") entirely;
  // the last segment is the local identity.
  let short = segs[segs.length - 1]
  for (let m = AUTOINDEX_PREFIX.exec(short); m; m = AUTOINDEX_PREFIX.exec(short)) {
    short = short.slice(m[0].length)
  }
  return short
}

/**
 * Primary display label for a fanout driver. Comb cells with hidden names
 * show "TYPE · shortNet" (e.g. "NAND · new_n27") instead of unreadable ABC
 * names; ports/FFs/named cells keep their own name.
 */
export function fanoutDriverLabel(driver: NodeRef, netName: string): string {
  if (driver.kind === 'cell' && !driver.seq && isHiddenName(driver.name)) {
    const short = shortNetName(netName)
    const type = displayCellType(driver.cell_type)
    return short ? `${type} · ${short}` : type
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
 * names pass through, grouped fallback names repeat only their count, and
 * hidden yosys/ABC names are suppressed.
 */
export function nodeSublabel(node: NodeRef): string | null {
  if (node.kind !== 'cell' || !node.name) return null
  if (isHiddenName(node.name)) return null

  // Vivado names inferred implementation cells after the package-facing
  // buffer they feed, even when the cell itself is a LUT or carry primitive:
  // `one_hot_OBUF[23]_inst_i_6_2`. Keep the useful RTL signal/bit and discard
  // the implementation plumbing, mirroring how Yosys auto names are hidden.
  const vivadoImplementationType = /^(?:LUT[1-6](?:_2)?|CARRY[48]|MUXF[789]|MUXCY|XORCY|FD(?:RE|CE|PE|SE|CPE|R|S|C|P)(?:_1)?|SRL(?:16E|C32E)|RAMB\w*|URAM\w*|DSP48\w*)$/i
  const vivado = vivadoImplementationType.test(node.cell_type ?? '')
    ? /^(.*?)_(?:IOBUF|IBUF|OBUF)(\[[^\]]+\])?_inst(?:_i(?:_\d+)*)?$/i.exec(node.name)
    : null
  if (vivado) return `${vivado[1]}${vivado[2] ?? ''}`

  const groupWidth = (node as GraphNode).width ?? 0
  if (groupWidth >= 2 && node.name === `${nodeLabel(node)} ×${groupWidth}`) {
    return `×${groupWidth}`
  }
  return node.name
}
