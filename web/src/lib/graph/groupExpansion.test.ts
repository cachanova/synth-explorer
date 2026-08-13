import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../../types'
import { applyGroupExpansions, openExpandedGroup } from './groupExpansion'

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

  it('keeps two open groups expanded and wires their members to each other', () => {
    const base = graph(
      [node(100, [1, 2]), node(200, [3, 4])],
      [{ from: 100, to: 200, from_port: 'Q', to_port: 'D', net_name: 'bus', bits: [1, 2] }],
    )
    // Each response is projected with both groups open, so the net between them
    // already names raw members instead of the neighbor's synthetic node.
    const crossEdges: Subgraph['edges'] = [
      { from: 1, to: 3, from_port: 'Q', to_port: 'D', net_name: 'bus', bits: [1] },
      { from: 2, to: 4, from_port: 'Q', to_port: 'D', net_name: 'bus', bits: [2] },
    ]
    const first = graph([node(1), node(2), node(3), node(4)], crossEdges)
    const second = graph([node(3), node(4), node(1), node(2)], crossEdges)

    const result = applyGroupExpansions(base, [
      { id: 100, label: 'a[1:0]', members: [1, 2], graph: first, boundary_trunks: [] },
      { id: 200, label: 'b[1:0]', members: [3, 4], graph: second, boundary_trunks: [] },
    ], 8)

    expect(result.graph.nodes.map((entry) => entry.id).sort()).toEqual([1, 2, 3, 4])
    expect(result.graph.edges).toEqual(crossEdges)
    expect(result.groups).toEqual([
      { id: 100, label: 'a[1:0]', members: [1, 2] },
      { id: 200, label: 'b[1:0]', members: [3, 4] },
    ])
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

describe('openExpandedGroup', () => {
  it('keeps the groups already open when another one opens', () => {
    const first = openExpandedGroup([], { id: 100, label: 'a[1:0]' }, 400)
    const both = openExpandedGroup(first, { id: 200, label: 'b[1:0]' }, 980)

    expect(both).toEqual([
      { id: 100, label: 'a[1:0]', referenceHeight: 400 },
      // The taller diagram the first expansion produced must not relax the
      // second group's stacking budget.
      { id: 200, label: 'b[1:0]', referenceHeight: 400 },
    ])
  })

  it('ignores a group that is already open', () => {
    const open = openExpandedGroup([], { id: 100, label: 'a[1:0]' }, 400)

    expect(openExpandedGroup(open, { id: 100, label: 'a[1:0]' }, 980)).toBe(open)
  })
})
