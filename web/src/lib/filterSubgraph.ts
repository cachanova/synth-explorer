import type { GraphRequest } from '../store'
import type { GraphNode, Subgraph } from '../types'

// Context anchors stay visible around the focused set: ports, constants,
// sequential cells, and traversal boundaries orient the reader.
function isAnchor(node: GraphNode): boolean {
  return node.kind !== 'cell' || Boolean(node.seq) || Boolean(node.is_boundary)
}

/**
 * Keep the nodes in `keep` plus up to `boundaryHops` rounds of adjacent
 * context anchors; drop everything else and any edge touching a dropped
 * node. Returns the input unchanged (same reference) when `keep` is empty
 * or nothing would be dropped.
 */
export function filterSubgraph(
  sub: Subgraph,
  keep: ReadonlySet<number>,
  boundaryHops = 1,
): Subgraph {
  if (keep.size === 0) return sub
  const byId = new Map(sub.nodes.map((node) => [node.id, node]))
  const kept = new Set<number>()
  // A grouped vector node has a synthetic id but keeps its member bit ids;
  // it is kept when the group id or any member bit is in the keep set.
  for (const node of sub.nodes) {
    if (keep.has(node.id) || node.members?.some((member) => keep.has(member))) {
      kept.add(node.id)
    }
  }
  for (let hop = 0; hop < boundaryHops; hop++) {
    const added: number[] = []
    for (const edge of sub.edges) {
      const fromKept = kept.has(edge.from)
      if (fromKept === kept.has(edge.to)) continue
      const neighbor = byId.get(fromKept ? edge.to : edge.from)
      if (neighbor && isAnchor(neighbor)) added.push(neighbor.id)
    }
    if (added.length === 0) break
    for (const id of added) kept.add(id)
  }
  const nodes = sub.nodes.filter((node) => kept.has(node.id))
  if (nodes.length === sub.nodes.length) return sub
  const edges = sub.edges.filter(
    (edge) => kept.has(edge.from) && kept.has(edge.to),
  )
  return { nodes, edges, truncated: sub.truncated }
}

/**
 * The selection-relevant node set for the Focus toggle: probe roots for
 * source selections, the highlighted set for cone/netlist views, and null
 * (toggle no-op) when the view has no selection to focus on.
 */
export function focusKeepSet(
  req: Pick<GraphRequest, 'kind' | 'highlight'>,
  sub: Subgraph,
): ReadonlySet<number> | null {
  if (req.kind === 'source') {
    return new Set(
      sub.nodes.filter((node) => node.is_root).map((node) => node.id),
    )
  }
  return req.highlight.length > 0 ? new Set(req.highlight) : null
}
