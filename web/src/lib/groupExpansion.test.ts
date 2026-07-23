import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import { applyGroupExpansions } from './groupExpansion'

const node = (id: number, members?: number[]): GraphNode => ({
  id,
  kind: 'cell',
  name: `n${id}`,
  cell_type: 'FDRE',
  ...(members ? { members, member_count: members.length, width: members.length } : {}),
})

const graph = (nodes: GraphNode[], edges: Subgraph['edges'] = []): Subgraph => ({
  nodes,
  edges,
  truncated: false,
})

describe('applyGroupExpansions', () => {
  it('replaces the synthetic node, preserves external wiring, and prioritizes members', () => {
    const base = graph(
      [node(100, [1, 2]), node(9)],
      [{ from: 100, to: 9, from_port: 'Q', to_port: 'D', net_name: 'q', bits: [1] }],
    )
    const expansion = graph(
      [node(1), node(2), node(8), node(9)],
      [
        { from: 1, to: 9, from_port: 'Q', to_port: 'D', net_name: 'q', bits: [1] },
        { from: 2, to: 9, from_port: 'Q', to_port: 'D', net_name: 'q', bits: [2] },
        { from: 1, to: 8, from_port: 'Q', to_port: 'D', net_name: 'hidden', bits: [3] },
      ],
    )

    const result = applyGroupExpansions(base, [{
      id: 100,
      label: 'q[1:0]',
      members: [1, 2],
      graph: expansion,
      boundary_trunks: [],
    }], 3)

    expect(result.graph.nodes.map((entry) => entry.id)).toEqual([1, 2, 9])
    expect(result.graph.nodes).not.toContainEqual(expect.objectContaining({ id: 100 }))
    expect(result.graph.edges).toEqual(expansion.edges.slice(0, 2))
    expect(result.graph.truncated).toBe(false)
    expect(result.groups).toEqual([{ id: 100, label: 'q[1:0]', members: [1, 2] }])
  })

  it('does not leak an expansion into a projection without its synthetic group', () => {
    const focused = graph([node(9)])
    const result = applyGroupExpansions(focused, [{
      id: 100,
      label: 'q[1:0]',
      members: [1, 2],
      graph: graph([node(1), node(2), node(9)]),
      boundary_trunks: [],
    }], 3)

    expect(result).toEqual({ graph: focused, groups: [] })
  })
})
