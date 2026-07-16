import type { Subgraph } from '../types'

const MAX_CONTEXT_ROOTS = 200

type ContextRequest =
  | { kind: 'cone'; nodes: number[] }
  | { kind: 'source' }

/** Projected ids that seed the server's nearby-context projection. */
export function contextRootsFor(
  request: ContextRequest,
  graph: Subgraph,
  sourceHighlight: number[],
): number[] {
  const roots: number[] = []
  const seen = new Set<number>()
  const add = (ids: number[]) => {
    for (const id of ids) {
      if (roots.length >= MAX_CONTEXT_ROOTS) return
      if (seen.has(id)) continue
      seen.add(id)
      roots.push(id)
    }
  }
  if (request.kind === 'cone') add(request.nodes)
  else add(sourceHighlight)
  for (const node of graph.nodes) {
    if (node.is_boundary) add([node.id])
  }
  for (const node of graph.nodes) add([node.id])
  return roots
}
