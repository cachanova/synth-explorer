import { describe, expect, it } from 'vitest'
import type { Subgraph } from '../types'
import { coneRootIds, graphProjection } from './graphProjection'

const subgraph = (id: number): Subgraph => ({
  nodes: [{ id, kind: 'cell', name: `n${id}` }],
  edges: [],
  truncated: false,
})

describe('graph projection', () => {
  it('opens cones from the synthetic group id even for a large group', () => {
    const node = {
      id: 900,
      kind: 'cell' as const,
      name: 'memory [4096×64]',
      cell_type: 'RAM64M',
      members: Array.from({ length: 256 }, (_, index) => index),
    }

    expect(coneRootIds(node)).toEqual([900])
  })

  it('keeps the full schematic identity across non-focus selections', () => {
    const full = subgraph(1)

    expect(graphProjection(full, subgraph(2), false)).toBe(full)
    expect(graphProjection(full, subgraph(3), false)).toBe(full)
  })

  it('uses the selected subgraph only while Focus is on', () => {
    const full = subgraph(1)
    const firstRelevant = subgraph(2)
    const secondRelevant = subgraph(3)

    expect(graphProjection(full, firstRelevant, true)).toBe(firstRelevant)
    expect(graphProjection(full, secondRelevant, true)).toBe(secondRelevant)
    expect(graphProjection(full, null, true)).toBeNull()
  })
})
