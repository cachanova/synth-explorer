import type { GraphEdge, Subgraph } from '../types'

const edgeKey = (e: GraphEdge) => `${e.from}->${e.to}|${e.from_port}|${e.to_port}`

/**
 * Additive union of a base subgraph with an extra one — a node's expanded
 * fanin/fanout neighborhood from a double-click. Nodes dedupe by id and the
 * base node wins, so its root/boundary flags and grouping survive re-expansion.
 * Edges dedupe by (from, to, from_port, to_port) and only survive when both
 * endpoints are present. The node count is capped: extra nodes past `cap` are
 * dropped and the result is flagged truncated so the UI can say so.
 */
export function mergeSubgraphs(
  base: Subgraph,
  extra: Subgraph | null,
  cap: number,
): Subgraph {
  if (!extra || (extra.nodes.length === 0 && extra.edges.length === 0)) return base

  const nodes = [...base.nodes]
  const byId = new Set(nodes.map((n) => n.id))
  let dropped = false
  for (const node of extra.nodes) {
    if (byId.has(node.id)) continue
    if (nodes.length >= cap) {
      dropped = true
      continue
    }
    nodes.push(node)
    byId.add(node.id)
  }

  const edges = [...base.edges]
  const seen = new Set(edges.map(edgeKey))
  for (const edge of extra.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue
    const key = edgeKey(edge)
    if (seen.has(key)) continue
    seen.add(key)
    edges.push(edge)
  }

  return {
    nodes,
    edges,
    truncated: base.truncated || extra.truncated || dropped,
  }
}
