import type { GraphEdge, GroupExpansion, Subgraph } from '../types'
import { MAX_GRAPH_EDGES } from './graphLimits'

export interface ExpandedGroup extends GroupExpansion {
  id: number
  label: string
}

export interface AppliedGroupExpansions {
  graph: Subgraph
  groups: Array<{ id: number; label: string; members: number[] }>
}

const edgeKey = (edge: GraphEdge) =>
  `${edge.from}->${edge.to}|${edge.from_port}|${edge.to_port}`

/**
 * Replace synthetic quotient nodes with raw expansion projections. Physical
 * members win the render budget, followed by their one-hop context and then
 * the rest of the base schematic.
 */
export function applyGroupExpansions(
  base: Subgraph,
  expansions: ExpandedGroup[],
  cap: number,
): AppliedGroupExpansions {
  if (expansions.length === 0) return { graph: base, groups: [] }

  const baseIds = new Set(base.nodes.map((node) => node.id))
  const applicable = expansions.filter((entry) => baseIds.has(entry.id))
  if (applicable.length === 0) return { graph: base, groups: [] }

  const expandedIds = new Set(applicable.map((entry) => entry.id))
  const memberIds = new Set(applicable.flatMap((entry) => entry.members))
  const candidates = [
    ...applicable.flatMap((entry) =>
      entry.graph.nodes.filter((node) => memberIds.has(node.id)),
    ),
    // Keep only context already represented by the selected base projection.
    // The expansion response can contain thousands of one-hop raw neighbors;
    // admitting those would silently turn a local open-group action into a
    // second full-netlist render.
    ...applicable.flatMap((entry) =>
      entry.graph.nodes.filter((node) => !memberIds.has(node.id) && baseIds.has(node.id)),
    ),
    ...base.nodes.filter((node) => !expandedIds.has(node.id)),
  ]
  const nodes = [] as Subgraph['nodes']
  const nodeIds = new Set<number>()
  let truncated = base.truncated || applicable.some((entry) => entry.graph.truncated)
  for (const node of candidates) {
    if (nodeIds.has(node.id)) continue
    if (nodes.length >= cap) {
      truncated = true
      continue
    }
    nodes.push(node)
    nodeIds.add(node.id)
  }

  const edges: GraphEdge[] = []
  const seenEdges = new Set<string>()
  for (const edge of [
    ...applicable.flatMap((entry) => entry.graph.edges),
    ...base.edges,
  ]) {
    if (expandedIds.has(edge.from) || expandedIds.has(edge.to)) continue
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue
    const key = edgeKey(edge)
    if (seenEdges.has(key)) continue
    if (edges.length >= MAX_GRAPH_EDGES) {
      truncated = true
      continue
    }
    seenEdges.add(key)
    edges.push(edge)
  }

  return {
    graph: { nodes, edges, truncated },
    groups: applicable.map(({ id, label, members }) => ({ id, label, members })),
  }
}
