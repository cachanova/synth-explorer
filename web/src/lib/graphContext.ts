import type { Subgraph } from '../types'

const MAX_CONTEXT_ROOTS = 200

type ContextRequest =
  | { kind: 'cone'; nodes: number[] }
  | { kind: 'source' }

/** Real graph ids that seed the server's nearby-context projection. */
export function contextRootsFor(
  request: ContextRequest,
  graph: Subgraph,
  sourceHighlight: number[],
): number[] {
  const roots: number[] = []
  const seen = new Set<number>()
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const add = (ids: number[]) => {
    for (const id of ids) {
      if (roots.length >= MAX_CONTEXT_ROOTS) return
      if (seen.has(id)) continue
      seen.add(id)
      roots.push(id)
    }
  }
  if (request.kind === 'cone') add(request.nodes)
  else {
    for (const id of sourceHighlight) {
      const node = nodeById.get(id)
      add(node?.members ?? [id])
    }
  }
  for (const node of graph.nodes) {
    if (node.is_boundary) add(node.members ?? [node.id])
  }
  for (const node of graph.nodes) add(node.members ?? [node.id])
  return roots
}
