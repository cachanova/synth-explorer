import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, Subgraph } from '../types'
import { presentGraphForFocus } from './graphFocus'

const node = (id: number): GraphNode => ({ id, kind: 'cell', name: `n${id}` })
const edge = (from: number, to: number): GraphEdge => ({
  from,
  to,
  from_port: 'Y',
  to_port: 'A',
  net_name: `n${from}`,
  bits: [from],
})
const subgraph = (ids: number[], edges: GraphEdge[] = []): Subgraph => ({
  nodes: ids.map(node),
  edges,
  truncated: false,
})

describe('Focus graph presentation', () => {
  it('keeps the relevant subgraph unchanged while Focus is on', () => {
    const relevant = subgraph([2, 3], [edge(2, 3)])
    const full = subgraph([1, 2, 3, 4], [edge(1, 2), edge(2, 3), edge(3, 4)])

    const presentation = presentGraphForFocus(relevant, full, true, 400)

    expect(presentation.graph).toBe(relevant)
    expect(presentation.relevanceHighlight).toEqual([])
  })

  it('shows the full graph and highlights every relevant node while Focus is off', () => {
    const relevant = subgraph([2, 3], [edge(2, 3)])
    const full = subgraph([1, 2, 3, 4], [edge(1, 2), edge(2, 3), edge(3, 4)])

    const presentation = presentGraphForFocus(relevant, full, false, 400)

    expect(presentation.graph.nodes.map(({ id }) => id)).toEqual([2, 3, 1, 4])
    expect(presentation.graph.edges).toEqual([
      edge(2, 3),
      edge(1, 2),
      edge(3, 4),
    ])
    expect(presentation.relevanceHighlight).toEqual([2, 3])
  })

  it('retains relevant logic first when the capped full graph cannot all fit', () => {
    const relevant = subgraph([8, 9], [edge(8, 9)])
    const full = subgraph([1, 2, 3, 8, 9])

    const presentation = presentGraphForFocus(relevant, full, false, 3)

    expect(presentation.graph.nodes.map(({ id }) => id)).toEqual([8, 9, 1])
    expect(presentation.graph.truncated).toBe(true)
    expect(presentation.relevanceHighlight).toEqual([8, 9])
  })

  it('does not reintroduce hidden constants or control edges from the full graph', () => {
    const relevant = subgraph([2, 3], [edge(2, 3)])
    const constant: GraphNode = { id: 1, kind: 'const', name: "1'b0" }
    const controlEdge = { ...edge(4, 3), control: true }
    const full: Subgraph = {
      nodes: [constant, node(2), node(3), node(4)],
      edges: [edge(1, 2), edge(2, 3), controlEdge],
      truncated: false,
    }

    const presentation = presentGraphForFocus(relevant, full, false, 400, {
      hideConst: true,
      hideControl: true,
    })

    expect(presentation.graph.nodes.map(({ id }) => id)).toEqual([2, 3, 4])
    expect(presentation.graph.edges).toEqual([edge(2, 3)])
  })
})
