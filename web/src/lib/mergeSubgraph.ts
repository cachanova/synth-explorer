import type { GraphEdge, Subgraph } from '../types'
import { MAX_GRAPH_EDGES } from './graphLimits'

const edgeKey = (e: GraphEdge) => `${e.from}->${e.to}|${e.from_port}|${e.to_port}`

export interface MergeSubgraphsResult {
  graph: Subgraph
  droppedNodes: number
  droppedEdges: number
}

/**
 * Additive union of a base subgraph with an extra one — a node's expanded
 * fanin/fanout neighborhood from a double-click. Nodes dedupe by id and the
 * base node wins, so its root/boundary flags and grouping survive re-expansion.
 * Edges dedupe by (from, to, from_port, to_port) and only survive when both
 * endpoints are present. Nodes and merged edges stay within the shared render
 * caps; base content wins so the relevant cone survives before context or
 * expansion content, and any dropped content marks the result truncated.
 */
export function mergeSubgraphs(
  base: Subgraph,
  extra: Subgraph | null,
  cap: number,
): MergeSubgraphsResult {
  if (!extra || (extra.nodes.length === 0 && extra.edges.length === 0)) {
    return { graph: base, droppedNodes: 0, droppedEdges: 0 }
  }

  const nodes = base.nodes.slice(0, cap)
  const byId = new Set(nodes.map((n) => n.id))
  let dropped = base.nodes.length > cap
  let droppedNodes = Math.max(0, base.nodes.length - cap)
  for (const node of extra.nodes) {
    if (byId.has(node.id)) continue
    if (nodes.length >= cap) {
      dropped = true
      droppedNodes += 1
      continue
    }
    nodes.push(node)
    byId.add(node.id)
  }

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  let droppedEdges = 0
  for (const source of [base.edges, extra.edges]) {
    for (const edge of source) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) {
        droppedEdges += 1
        continue
      }
      const key = edgeKey(edge)
      if (seen.has(key)) continue
      if (edges.length >= MAX_GRAPH_EDGES) {
        dropped = true
        droppedEdges += 1
        continue
      }
      seen.add(key)
      edges.push(edge)
    }
  }

  return {
    graph: {
      nodes,
      edges,
      truncated: base.truncated || extra.truncated || dropped,
    },
    droppedNodes,
    droppedEdges,
  }
}
