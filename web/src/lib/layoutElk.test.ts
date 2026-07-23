import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import {
  DENSE_LAYOUT_NODE_THRESHOLD,
  DENSE_LONGEST_PATH_EDGE_DENSITY,
  interpretResult,
  prepareLayoutInput,
  toElkGraph,
  type LayoutInput,
} from './layout'

const node = (
  id: number,
  name: string,
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id,
  kind: 'port',
  name,
  ...extra,
})

describe('logic-oriented ELK layout policy', () => {
  it('aligns primary boundaries and routes an acyclic datapath from left to right', async () => {
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'a'),
        node(2, 'substantially_wider_input_name'),
        node(10, 'and_gate', { kind: 'cell', cell_type: '$_AND_' }),
        node(20, 'y'),
        node(21, 'substantially_wider_output_name'),
      ],
      edges: [
        { from: 1, to: 10, from_port: 'a', to_port: 'A', net_name: 'a', bits: [1] },
        { from: 2, to: 10, from_port: 'b', to_port: 'B', net_name: 'b', bits: [2] },
        { from: 10, to: 20, from_port: 'Y', to_port: 'y', net_name: 'y', bits: [3] },
        { from: 10, to: 21, from_port: 'Y', to_port: 'wide', net_name: 'wide', bits: [4] },
      ],
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph)
    const result = interpretResult(input, await new ELK().layout(toElkGraph(input)))
    const nodes = new Map(result.nodes.map((candidate) => [candidate.id, candidate]))
    const inputA = nodes.get(1)!
    const inputB = nodes.get(2)!
    const gate = nodes.get(10)!
    const outputA = nodes.get(20)!
    const outputB = nodes.get(21)!

    expect(inputA.x).toBeCloseTo(inputB.x)
    expect(outputA.x + outputA.width).toBeCloseTo(outputB.x + outputB.width)
    expect(gate.x).toBeGreaterThan(
      Math.max(inputA.x + inputA.width, inputB.x + inputB.width),
    )
    expect(Math.min(outputA.x, outputB.x)).toBeGreaterThan(gate.x + gate.width)
    for (const edge of result.edges) {
      const inputEdge = input.edges[edge.inputIndex]
      const source = nodes.get(inputEdge.from)!
      const target = nodes.get(inputEdge.to)!
      expect(edge.points[0].x).toBeCloseTo(source.x + source.width)
      expect(edge.points.at(-1)!.x).toBeCloseTo(target.x)
      expect(target.x).toBeGreaterThan(source.x + source.width)
    }
  })

  it('keeps hidden control-only primary inputs on the shared left boundary', async () => {
    const subgraph: Subgraph = {
      nodes: [
        node(1, 'clk'),
        node(2, 'rst'),
        node(3, 'data'),
        node(10, 'state', {
          kind: 'cell',
          cell_type: 'FDRE',
          seq: true,
          register: true,
          controls: [
            { role: 'clock', pin: 'C', net_name: 'clk', driver_id: 1, fanout: 1 },
            { role: 'reset', pin: 'R', net_name: 'rst', driver_id: 2, fanout: 1 },
          ],
        }),
        node(20, 'result'),
      ],
      edges: [
        { from: 3, to: 10, from_port: 'data', to_port: 'D', net_name: 'data', bits: [1] },
        { from: 10, to: 20, from_port: 'Q', to_port: 'result', net_name: 'result', bits: [2] },
      ],
      truncated: false,
    }
    const input = prepareLayoutInput(subgraph)
    const result = interpretResult(input, await new ELK().layout(toElkGraph(input)))
    const nodes = new Map(result.nodes.map((candidate) => [candidate.id, candidate]))

    expect(nodes.get(1)!.x).toBeCloseTo(nodes.get(3)!.x)
    expect(nodes.get(2)!.x).toBeCloseTo(nodes.get(3)!.x)
    for (const edge of result.edges) {
      const inputEdge = input.edges[edge.inputIndex]
      const source = nodes.get(inputEdge.from)!
      const target = nodes.get(inputEdge.to)!
      expect(edge.points[0].x).toBeCloseTo(source.x + source.width)
      expect(edge.points.at(-1)!.x).toBeCloseTo(target.x)
    }
  })

  it('packs orphan-heavy views without producing an extreme vertical ribbon', async () => {
    const isolatedNodes = 128
    const input: LayoutInput = {
      nodes: [
        {
          id: 1,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'input',
        },
        {
          id: 2,
          baseWidth: 76,
          baseHeight: 52,
          controlHeight: 0,
          register: false,
          boundary: 'internal',
        },
        {
          id: 3,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'output',
        },
        {
          id: 4,
          baseWidth: 74,
          baseHeight: 34,
          controlHeight: 0,
          register: false,
          boundary: 'input',
        },
        ...Array.from({ length: isolatedNodes }, (_, index) => ({
          id: index + 10,
          baseWidth: 62,
          baseHeight: 46,
          controlHeight: 0,
          register: false,
          boundary: 'internal' as const,
        })),
      ],
      edges: [
        {
          from: 1,
          to: 2,
          fromPort: 'Y',
          toPort: 'A',
          control: false,
        },
        {
          from: 2,
          to: 3,
          fromPort: 'Y',
          toPort: 'A',
          control: false,
        },
      ],
    }

    const result = await new ELK().layout(toElkGraph(input, 'BRANDES_KOEPF'))

    expect(result.children).toHaveLength(isolatedNodes + 4)
    expect(result.height).toBeLessThan(5_000)
  })
})

describe('dense ELK layout policy', () => {
  it('returns bounded orthogonal geometry without crossing nodes', async () => {
    const nodeCount = DENSE_LAYOUT_NODE_THRESHOLD
    const edgeCount = Math.ceil(nodeCount * DENSE_LONGEST_PATH_EDGE_DENSITY)
    const input: LayoutInput = {
      nodes: Array.from({ length: nodeCount }, (_, id) => ({
        id,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
        boundary: 'internal',
      })),
      edges: Array.from({ length: edgeCount }, (_, index) => ({
        from: index % (nodeCount / 2),
        to: nodeCount / 2 +
          ((index * 7 + Math.floor(index / (nodeCount / 2))) % (nodeCount / 2)),
        fromPort: `Y${index % 8}`,
        toPort: `A${Math.floor(index / (nodeCount / 2))}`,
        control: false,
      })),
    }
    const result = interpretResult(
      input,
      await new ELK().layout(toElkGraph(input, 'BRANDES_KOEPF')),
    )

    expect(result.nodes).toHaveLength(nodeCount)
    expect(result.edges).toHaveLength(edgeCount)
    const nodes = new Map(result.nodes.map((node) => [node.id, node]))
    let edgeNodeIntersections = 0
    for (const node of result.nodes) {
      expect(Number.isFinite(node.x) && node.x >= 0).toBe(true)
      expect(Number.isFinite(node.y) && node.y >= 0).toBe(true)
      expect(node.x + node.width).toBeLessThanOrEqual(result.width)
      expect(node.y + node.height).toBeLessThanOrEqual(result.height)
    }
    for (const edge of result.edges) {
      const inputEdge = input.edges[edge.inputIndex]
      const source = nodes.get(inputEdge.from)!
      const target = nodes.get(inputEdge.to)!
      expect(edge.points.length).toBeGreaterThanOrEqual(2)
      expect(edge.points[0].x).toBeCloseTo(source.x + source.width)
      expect(edge.points.at(-1)!.x).toBeCloseTo(target.x)
      for (let index = 1; index < edge.points.length; index += 1) {
        const previous = edge.points[index - 1]
        const point = edge.points[index]
        expect(point.x === previous.x || point.y === previous.y).toBe(true)
        for (const node of result.nodes) {
          if (node.id === inputEdge.from || node.id === inputEdge.to) continue
          const crossesInterior = previous.y === point.y
            ? node.x < Math.max(previous.x, point.x) &&
              Math.min(previous.x, point.x) < node.x + node.width &&
              node.y < point.y && point.y < node.y + node.height
            : node.y < Math.max(previous.y, point.y) &&
              Math.min(previous.y, point.y) < node.y + node.height &&
              node.x < point.x && point.x < node.x + node.width
          if (crossesInterior) edgeNodeIntersections += 1
        }
      }
    }
    expect(edgeNodeIntersections).toBe(0)
  }, 20_000)
})
