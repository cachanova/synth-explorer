import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import {
  applyGroupExpansions,
  groupExpansionReducer,
  initialGroupExpansionState,
  type ExpandedGroup,
} from './groupExpansion'

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

const expansion = (id: number): ExpandedGroup => ({
  id,
  label: `g${id}`,
  requestKey: `${id}`,
  members: [id + 1],
  graph: graph([node(id + 1)]),
  boundary_trunks: [],
})

describe('groupExpansionReducer', () => {
  it('preserves every unrelated group across arbitrary open and close actions', () => {
    const ownerKey = 'design|vectors|memories'
    let state = groupExpansionReducer(initialGroupExpansionState(), {
      type: 'open',
      ownerKey,
      spec: { id: 200, label: 'g200', referenceHeight: 500 },
    })
    state = groupExpansionReducer(state, {
      type: 'open',
      ownerKey,
      spec: { id: 100, label: 'g100', referenceHeight: 500 },
    })
    state = groupExpansionReducer(state, {
      type: 'loaded',
      ownerKey,
      expansion: expansion(200),
    })
    state = groupExpansionReducer(state, {
      type: 'loaded',
      ownerKey,
      expansion: expansion(100),
    })

    expect(state.specs.map(({ id }) => id)).toEqual([100, 200])
    expect(state.expansions.map(({ id }) => id)).toEqual([100, 200])

    state = groupExpansionReducer(state, {
      type: 'close',
      ownerKey,
      id: 100,
    })
    expect(state.specs.map(({ id }) => id)).toEqual([200])
    expect(state.expansions.map(({ id }) => id)).toEqual([200])

    state = groupExpansionReducer(state, {
      type: 'open',
      ownerKey,
      spec: { id: 100, label: 'g100', referenceHeight: 500 },
    })
    expect(state.specs.map(({ id }) => id)).toEqual([100, 200])
    expect(state.expansions.map(({ id }) => id)).toEqual([200])
  })

  it('ignores late responses for collapsed groups and stale owners', () => {
    const ownerKey = 'current'
    let state = groupExpansionReducer(initialGroupExpansionState(), {
      type: 'open',
      ownerKey,
      spec: { id: 100, label: 'g100', referenceHeight: 500 },
    })
    state = groupExpansionReducer(state, {
      type: 'close',
      ownerKey,
      id: 100,
    })
    expect(groupExpansionReducer(state, {
      type: 'loaded',
      ownerKey,
      expansion: expansion(100),
    })).toBe(state)
    expect(groupExpansionReducer(state, {
      type: 'loaded',
      ownerKey: 'stale',
      expansion: expansion(100),
    })).toBe(state)
  })
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
      requestKey: '100',
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
      requestKey: '100',
      members: [1, 2],
      graph: graph([node(1), node(2), node(9)]),
      boundary_trunks: [],
    }], 3)

    expect(result).toEqual({ graph: focused, groups: [] })
  })

  it('produces the same combined graph regardless of expansion arrival order', () => {
    const base = graph([node(100, [101]), node(200, [201]), node(9)])
    const first = {
      ...expansion(100),
      graph: graph([node(101), node(200, [201]), node(9)]),
    }
    const second = {
      ...expansion(200),
      graph: graph([node(201), node(100, [101]), node(9)]),
    }

    const result = applyGroupExpansions(base, [first, second], 10)
    expect(result).toEqual(applyGroupExpansions(base, [second, first], 10))
    expect(result.graph.nodes.map(({ id }) => id)).toEqual([101, 201, 9])
  })
})
