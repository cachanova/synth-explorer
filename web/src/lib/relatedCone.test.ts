import { describe, expect, it } from 'vitest'
import { relatedCone, type RelatedConeEdge, type RelatedConeNode } from './relatedCone'

function ids(...values: number[]): RelatedConeNode[] {
  return values.map((id) => ({ id }))
}

function edges(...pairs: Array<[number, number]>): RelatedConeEdge[] {
  return pairs.map(([from, to]) => ({ from, to }))
}

function sorted(values: ReadonlySet<number>): number[] {
  return [...values].sort((left, right) => left - right)
}

describe('relatedCone', () => {
  it('includes both directions of a chain from a selected node', () => {
    const cone = relatedCone(
      ids(1, 2, 3, 4),
      edges([1, 2], [2, 3], [3, 4]),
      { kind: 'node', nodeId: 3 },
    )

    expect(sorted(cone.nodeIds)).toEqual([1, 2, 3, 4])
    expect(sorted(cone.edgeKeys)).toEqual([0, 1, 2])
  })

  it('keeps only directed fanin and fanout paths through a diamond branch', () => {
    const cone = relatedCone(
      ids(1, 2, 3, 4),
      edges([1, 2], [1, 3], [2, 4], [3, 4]),
      { kind: 'node', nodeId: 2 },
    )

    expect(sorted(cone.nodeIds)).toEqual([1, 2, 4])
    expect(sorted(cone.edgeKeys)).toEqual([0, 2])
  })

  it('excludes a disconnected component', () => {
    const cone = relatedCone(
      ids(1, 2, 3, 4),
      edges([1, 2], [3, 4]),
      { kind: 'node', nodeId: 1 },
    )

    expect(sorted(cone.nodeIds)).toEqual([1, 2])
    expect(sorted(cone.edgeKeys)).toEqual([0])
  })

  it('seeds the cone from both endpoints of a selected edge', () => {
    const cone = relatedCone(
      ids(1, 2, 3, 4, 5, 6),
      edges([1, 2], [2, 3], [3, 4], [5, 3], [2, 6]),
      { kind: 'edge', edgeKeys: [1] },
    )

    expect(sorted(cone.nodeIds)).toEqual([1, 2, 3, 4])
    expect(sorted(cone.edgeKeys)).toEqual([0, 1, 2])
  })

  it('treats grouped members as aliases of their rendered node', () => {
    const cone = relatedCone(
      [
        { id: 1 },
        { id: 10, members: [2, 3] },
        { id: 4 },
        { id: 5 },
      ],
      edges([1, 2], [3, 4]),
      { kind: 'node', nodeId: 10 },
    )

    expect(sorted(cone.nodeIds)).toEqual([1, 4, 10])
    expect(sorted(cone.edgeKeys)).toEqual([0, 1])
  })

  it('terminates on cycles while retaining every related edge', () => {
    const cone = relatedCone(
      ids(1, 2, 3),
      edges([1, 2], [2, 3], [3, 1]),
      { kind: 'node', nodeId: 2 },
    )

    expect(sorted(cone.nodeIds)).toEqual([1, 2, 3])
    expect(sorted(cone.edgeKeys)).toEqual([0, 1, 2])
  })

  it('ignores unknown selected edge keys', () => {
    const cone = relatedCone(
      ids(1, 2),
      edges([1, 2]),
      { kind: 'edge', edgeKeys: [99] },
    )

    expect(sorted(cone.nodeIds)).toEqual([])
    expect(sorted(cone.edgeKeys)).toEqual([])
  })

  it('does not alias a rendered node id into a group', () => {
    const cone = relatedCone(
      [
        { id: 1 },
        { id: 10, members: [1, 2] },
        { id: 4 },
      ],
      edges([1, 4], [2, 4]),
      { kind: 'node', nodeId: 10 },
    )

    expect(sorted(cone.nodeIds)).toEqual([4, 10])
    expect(sorted(cone.edgeKeys)).toEqual([1])
  })
})
