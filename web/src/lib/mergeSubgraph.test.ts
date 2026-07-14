import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, Subgraph } from '../types'
import { MAX_GRAPH_EDGES } from './graphLimits'
import { mergeSubgraphs } from './mergeSubgraph'

const node = (id: number, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'cell',
  name: `n${id}`,
  ...extra,
})

const edge = (from: number, to: number, port = 'Y'): GraphEdge => ({
  from,
  to,
  from_port: port,
  to_port: 'A',
  net_name: `net${from}`,
  bits: [from],
})

const sub = (nodes: GraphNode[], edges: GraphEdge[], truncated = false): Subgraph => ({
  nodes,
  edges,
  truncated,
})

describe('mergeSubgraphs', () => {
  it('returns the base unchanged when there is nothing to merge', () => {
    const base = sub([node(1)], [])
    expect(mergeSubgraphs(base, null, 100)).toBe(base)
    expect(mergeSubgraphs(base, sub([], []), 100)).toBe(base)
  })

  it('adds new neighbor nodes and edges without duplicating shared ones', () => {
    const base = sub([node(1), node(2)], [edge(1, 2)])
    const extra = sub([node(2), node(3)], [edge(1, 2), edge(2, 3)])

    const merged = mergeSubgraphs(base, extra, 100)

    expect(merged.nodes.map((n) => n.id)).toEqual([1, 2, 3])
    expect(merged.edges).toHaveLength(2)
    expect(merged.edges.map((e) => `${e.from}-${e.to}`)).toEqual(['1-2', '2-3'])
  })

  it('keeps the base copy of a shared node so its flags survive', () => {
    const base = sub([node(2, { is_root: true })], [])
    const extra = sub([node(2, { is_boundary: true })], [])

    const merged = mergeSubgraphs(base, extra, 100)

    expect(merged.nodes).toHaveLength(1)
    expect(merged.nodes[0].is_root).toBe(true)
    expect(merged.nodes[0].is_boundary).toBeUndefined()
  })

  it('drops edges whose endpoint was not admitted', () => {
    const base = sub([node(1)], [])
    // cap of 1 leaves no room for node 2, so the 1->2 edge cannot be kept.
    const extra = sub([node(2)], [edge(1, 2)])

    const merged = mergeSubgraphs(base, extra, 1)

    expect(merged.nodes.map((n) => n.id)).toEqual([1])
    expect(merged.edges).toHaveLength(0)
    expect(merged.truncated).toBe(true)
  })

  it('propagates truncation from either input', () => {
    expect(mergeSubgraphs(sub([node(1)], [], true), sub([node(2)], []), 100).truncated).toBe(
      true,
    )
    expect(mergeSubgraphs(sub([node(1)], []), sub([node(2)], [], true), 100).truncated).toBe(
      true,
    )
  })

  it('caps merged edges while preserving base relevance first', () => {
    const baseEdge = edge(1, 2, 'relevant')
    const extras = Array.from({ length: MAX_GRAPH_EDGES }, (_, index) => ({
      ...edge(1, 2, 'extra'),
      to_port: `A${index}`,
    }))

    const merged = mergeSubgraphs(
      sub([node(1), node(2)], [baseEdge]),
      sub([node(1), node(2)], extras),
      100,
    )

    expect(merged.edges).toHaveLength(MAX_GRAPH_EDGES)
    expect(merged.edges[0]).toBe(baseEdge)
    expect(merged.truncated).toBe(true)
  })
})
