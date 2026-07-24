export interface RelatedConeNode {
  id: number
  members?: readonly number[]
}

export interface RelatedConeEdge {
  from: number
  to: number
}

export type RelatedConeSelection =
  | { kind: 'node'; nodeId: number }
  | { kind: 'edge'; edgeKeys: readonly number[] }

export interface RelatedCone {
  nodeIds: Set<number>
  edgeKeys: Set<number>
}

interface IndexedEdge {
  key: number
  from: number
  to: number
}

/**
 * Finds the rendered ancestors and descendants of a selected node or edge.
 * Edge keys are their indexes in the displayed edge array.
 */
export function relatedCone(
  nodes: readonly RelatedConeNode[],
  edges: readonly RelatedConeEdge[],
  selection: RelatedConeSelection,
): RelatedCone {
  const renderedIds = new Set(nodes.map((node) => node.id))
  const renderedIdByAlias = new Map<number, number>()
  for (const node of nodes) {
    renderedIdByAlias.set(node.id, node.id)
  }
  for (const node of nodes) {
    for (const member of node.members ?? []) {
      if (renderedIds.has(member)) continue
      renderedIdByAlias.set(member, node.id)
    }
  }

  const indexedEdges = new Map<number, IndexedEdge>()
  const incoming = new Map<number, IndexedEdge[]>()
  const outgoing = new Map<number, IndexedEdge[]>()
  edges.forEach((edge, key) => {
    const from = renderedIdByAlias.get(edge.from)
    const to = renderedIdByAlias.get(edge.to)
    if (from == null || to == null) return
    const indexed = { key, from, to }
    indexedEdges.set(key, indexed)
    const fromEdges = outgoing.get(from)
    if (fromEdges) fromEdges.push(indexed)
    else outgoing.set(from, [indexed])
    const toEdges = incoming.get(to)
    if (toEdges) toEdges.push(indexed)
    else incoming.set(to, [indexed])
  })

  const nodeIds = new Set<number>()
  const edgeKeys = new Set<number>()
  const incomingSeeds = new Set<number>()
  const outgoingSeeds = new Set<number>()
  if (selection.kind === 'node') {
    const nodeId = renderedIdByAlias.get(selection.nodeId)
    if (nodeId != null) {
      nodeIds.add(nodeId)
      incomingSeeds.add(nodeId)
      outgoingSeeds.add(nodeId)
    }
  } else {
    const selectedKeys = new Set(selection.edgeKeys)
    for (const key of selectedKeys) {
      const edge = indexedEdges.get(key)
      if (!edge) continue
      edgeKeys.add(key)
      nodeIds.add(edge.from)
      nodeIds.add(edge.to)
      incomingSeeds.add(edge.from)
      outgoingSeeds.add(edge.to)
    }
  }

  const traverse = (
    seeds: ReadonlySet<number>,
    adjacency: ReadonlyMap<number, readonly IndexedEdge[]>,
    adjacentNode: (edge: IndexedEdge) => number,
  ) => {
    const visited = new Set(seeds)
    const queue = [...seeds]
    let cursor = 0
    while (cursor < queue.length) {
      const current = queue[cursor]
      cursor += 1
      for (const edge of adjacency.get(current) ?? []) {
        edgeKeys.add(edge.key)
        const next = adjacentNode(edge)
        nodeIds.add(next)
        if (visited.has(next)) continue
        visited.add(next)
        queue.push(next)
      }
    }
  }

  traverse(incomingSeeds, incoming, (edge) => edge.from)
  traverse(outgoingSeeds, outgoing, (edge) => edge.to)
  return { nodeIds, edgeKeys }
}
