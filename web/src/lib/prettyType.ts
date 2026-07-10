// Pretty-printing of yosys cell type names for node labels.

import type { GraphNode, NodeRef } from '../types'

/**
 * Turn a raw yosys cell type into a compact human label.
 *   "$_NAND_" -> "NAND"
 *   "$and"    -> "AND"
 *   "$_SDFF_PP0_" -> "SDFF_PP0"
 *   "$lut"    -> "LUT"
 *   "SB_LUT4" -> "SB_LUT4"  (vendor prims kept as-is)
 */
export function prettyCellType(cellType: string | undefined): string {
  if (!cellType) return '?'
  let t = cellType
  // Strip gate-primitive wrapper: $_NAND_ -> NAND
  if (t.startsWith('$_') && t.endsWith('_')) {
    t = t.slice(2, -1)
  } else if (t.startsWith('$')) {
    t = t.slice(1)
  }
  return t.toUpperCase()
}

/** LUT width from params (WIDTH), if present. */
export function lutWidth(params: Record<string, string> | undefined): number | null {
  if (!params) return null
  const w = params.WIDTH ?? params.width
  if (w == null) return null
  const n = Number(w)
  return Number.isFinite(n) ? n : null
}

/**
 * Full node label: for LUT cells append the width ("LUT4"). Ports and consts
 * use their name.
 */
export function nodeLabel(node: GraphNode | NodeRef): string {
  if (node.kind === 'port') return node.name
  if (node.kind === 'const') return node.name
  const base = prettyCellType(node.cell_type)
  const gn = node as GraphNode
  if (base === 'LUT') {
    const w = lutWidth(gn.params)
    if (w != null) return `LUT${w}`
  }
  return base
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
    return `${prettyCellType(driver.cell_type)} · ${shortNetName(netName)}`
  }
  return driver.name
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
