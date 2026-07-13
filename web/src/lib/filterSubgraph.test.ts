import { describe, expect, it } from 'vitest'
import { filterSubgraph, focusKeepSet } from './filterSubgraph'
import type { GraphNode, Subgraph } from '../types'

function node(id: number, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, kind: 'cell', name: `n${id}`, ...extra }
}

function edge(from: number, to: number) {
  return { from, to, from_port: 'Y', to_port: 'A', net_name: `net${from}`, bits: [0] }
}

// 2(port) -> 1(root cell) -> 3(cell) -> 5(cell), 4(register) -> 1
const sub: Subgraph = {
  nodes: [
    node(1, { is_root: true }),
    node(2, { kind: 'port' }),
    node(3),
    node(4, { seq: true, register: true }),
    node(5),
  ],
  edges: [edge(2, 1), edge(1, 3), edge(4, 1), edge(3, 5)],
  truncated: true,
}

describe('filterSubgraph', () => {
  it('keeps the root and adjacent anchors, dropping distant cells', () => {
    const out = filterSubgraph(sub, new Set([1]))
    expect(out.nodes.map((n) => n.id)).toEqual([1, 2, 4])
    expect(out.truncated).toBe(true)
  })

  it('keeps a register neighbor as a context anchor', () => {
    const out = filterSubgraph(sub, new Set([1]))
    expect(out.nodes.some((n) => n.id === 4)).toBe(true)
  })

  it('removes edges touching dropped nodes', () => {
    const out = filterSubgraph(sub, new Set([1]))
    expect(out.edges).toEqual([edge(2, 1), edge(4, 1)])
  })

  it('returns the identical reference for an empty keep set', () => {
    expect(filterSubgraph(sub, new Set())).toBe(sub)
  })

  it('returns the identical reference when nothing is dropped', () => {
    expect(filterSubgraph(sub, new Set([1, 2, 3, 4, 5]))).toBe(sub)
  })

  it('keeps only the keep set with boundaryHops=0', () => {
    const out = filterSubgraph(sub, new Set([1]), 0)
    expect(out.nodes.map((n) => n.id)).toEqual([1])
    expect(out.edges).toEqual([])
  })

  it('keeps a grouped node when any of its members is in the keep set', () => {
    // A grouped vector node has a synthetic id but carries its member bit ids;
    // highlighting one bit must retain the whole group (spec C).
    const grouped: Subgraph = {
      nodes: [
        node(100, { width: 8, members: [10, 11, 12] }),
        node(2, { kind: 'port' }),
        node(3),
      ],
      edges: [edge(2, 100), edge(100, 3)],
      truncated: false,
    }
    const out = filterSubgraph(grouped, new Set([11]))
    expect(out.nodes.map((n) => n.id).sort((a, b) => a - b)).toEqual([2, 100])
  })
})

describe('focusKeepSet', () => {
  it('keeps root nodes for source probes', () => {
    const keep = focusKeepSet({ kind: 'source', highlight: [] }, sub)
    expect(keep && [...keep]).toEqual([1])
  })

  it('keeps highlighted nodes for cone and netlist views', () => {
    const keep = focusKeepSet({ kind: 'cone', highlight: [3, 5] }, sub)
    expect(keep && [...keep].sort()).toEqual([3, 5])
    const netlist = focusKeepSet({ kind: 'netlist', highlight: [4] }, sub)
    expect(netlist && [...netlist]).toEqual([4])
  })

  it('is a no-op for cone and netlist views without a highlight', () => {
    expect(focusKeepSet({ kind: 'cone', highlight: [] }, sub)).toBeNull()
    expect(focusKeepSet({ kind: 'netlist', highlight: [] }, sub)).toBeNull()
  })
})
