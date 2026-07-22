import { expect, it, vi } from 'vitest'
import type { LayoutInput } from '../lib/layout'
import { runSchemWeaveRequest } from './schemweaveRuntime'

const input: LayoutInput = {
  nodes: [
    { id: 1, baseWidth: 62, baseHeight: 46, controlHeight: 0, register: false, cycleBreaker: false },
    { id: 2, baseWidth: 62, baseHeight: 46, controlHeight: 0, register: false, cycleBreaker: false },
  ],
  edges: [{
    from: 1,
    to: 2,
    fromPort: 'Y',
    toPort: 'A',
    control: false,
    net: 0,
  }],
}

it('serializes compact input and adapts SchemWeave geometry', () => {
  const layout_json = vi.fn().mockReturnValue(JSON.stringify({
    nodes: [
      { id: 1, x: 0, y: 0, width: 62, height: 46 },
      { id: 2, x: 128, y: 0, width: 62, height: 46 },
    ],
    edges: [{ id: 0, points: [{ x: 62, y: 23 }, { x: 128, y: 23 }] }],
    width: 190,
    height: 46,
  }))

  expect(runSchemWeaveRequest({ layout_json }, { id: 41, input })).toEqual({
    id: 41,
    ok: true,
    result: {
      nodes: [
        { id: 1, x: 0, y: 0, width: 62, height: 46 },
        { id: 2, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{ inputIndex: 0, points: [{ x: 62, y: 23 }, { x: 128, y: 23 }] }],
      width: 190,
      height: 46,
    },
  })

  const graph = JSON.parse(layout_json.mock.calls[0][0])
  expect(graph).toMatchObject({
    nodes: [
      { id: 1, width: 62, height: 46, cycle_breaker: false },
      { id: 2, width: 62, height: 46, cycle_breaker: false },
    ],
    edges: [{
      id: 0,
      source: { node: 1, port: 0 },
      target: { node: 2, port: 0 },
      net: 0,
      participates_in_ranking: true,
    }],
  })
})

it('returns an explicit protocol error when layout fails', () => {
  const layout_json = vi.fn(() => {
    throw new Error('layout failed')
  })

  expect(runSchemWeaveRequest({ layout_json }, { id: 9, input })).toEqual({
    id: 9,
    ok: false,
    error: 'layout failed',
  })
})
