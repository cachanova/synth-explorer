import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import { contextRootsFor } from './graphContext'

const graph = (nodes: GraphNode[]): Subgraph => ({
  nodes,
  edges: [],
  truncated: false,
})

describe('contextRootsFor', () => {
  it('expands grouped source highlights to real member ids', () => {
    const relevant = graph([
      { id: 18, kind: 'cell', name: 'inv' },
      { id: 32, kind: 'cell', name: 'wait_count', members: [22, 23, 24, 25] },
    ])

    expect(contextRootsFor({ kind: 'source' }, relevant, [18, 32])).toEqual([
      18, 22, 23, 24, 25,
    ])
  })

  it('prioritizes explicit cone roots and boundary neighbors', () => {
    const relevant = graph([
      { id: 8, kind: 'cell', name: 'root' },
      { id: 7, kind: 'cell', name: 'boundary', is_boundary: true },
      { id: 6, kind: 'cell', name: 'inner' },
    ])

    expect(contextRootsFor({ kind: 'cone', nodes: [8] }, relevant, [])).toEqual([
      8, 7, 6,
    ])
  })
})
