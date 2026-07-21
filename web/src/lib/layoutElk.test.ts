import ELK from 'elkjs/lib/elk.bundled.js'
import { describe, expect, it } from 'vitest'
import {
  DENSE_LAYOUT_NODE_THRESHOLD,
  DENSE_LONGEST_PATH_EDGE_DENSITY,
  interpretResult,
  toElkGraph,
  type LayoutInput,
} from './layout'

describe('dense ELK layout policy', () => {
  it('produces deterministic, bounded, fixed-side orthogonal geometry', async () => {
    const nodeCount = DENSE_LAYOUT_NODE_THRESHOLD
    const edgeCount = Math.ceil(
      nodeCount * DENSE_LONGEST_PATH_EDGE_DENSITY,
    )
    const input: LayoutInput = {
      nodes: Array.from({ length: nodeCount }, (_, id) => ({
        id,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
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
    const elk = new ELK()
    const run = async () =>
      interpretResult(
        input,
        await elk.layout(toElkGraph(input, 'BRANDES_KOEPF')),
      )

    const first = await run()
    const second = await run()
    expect(second).toEqual(first)
    expect(first.nodes).toHaveLength(nodeCount)
    expect(first.edges).toHaveLength(edgeCount)

    const nodes = new Map(first.nodes.map((node) => [node.id, node]))
    let edgeNodeIntersections = 0
    for (const node of first.nodes) {
      expect(Number.isFinite(node.x) && node.x >= 0).toBe(true)
      expect(Number.isFinite(node.y) && node.y >= 0).toBe(true)
      expect(node.x + node.width).toBeLessThanOrEqual(first.width)
      expect(node.y + node.height).toBeLessThanOrEqual(first.height)
    }
    for (const edge of first.edges) {
      const inputEdge = input.edges[edge.inputIndex]
      const source = nodes.get(inputEdge.from)!
      const target = nodes.get(inputEdge.to)!
      expect(edge.points.length).toBeGreaterThanOrEqual(2)
      expect(edge.points[0].x).toBeCloseTo(source.x + source.width)
      expect(edge.points.at(-1)!.x).toBeCloseTo(target.x)
      expect(edge.points[1].y).toBeCloseTo(edge.points[0].y)
      expect(edge.points[1].x).toBeGreaterThanOrEqual(edge.points[0].x)
      expect(edge.points.at(-2)!.y).toBeCloseTo(edge.points.at(-1)!.y)
      expect(edge.points.at(-2)!.x).toBeLessThanOrEqual(edge.points.at(-1)!.x)
      for (const point of edge.points) {
        expect(Number.isFinite(point.x) && point.x >= 0).toBe(true)
        expect(Number.isFinite(point.y) && point.y >= 0).toBe(true)
        expect(point.x).toBeLessThanOrEqual(first.width)
        expect(point.y).toBeLessThanOrEqual(first.height)
      }
      for (let index = 1; index < edge.points.length; index += 1) {
        const previous = edge.points[index - 1]
        const point = edge.points[index]
        expect(point.x === previous.x || point.y === previous.y).toBe(true)
        for (const node of first.nodes) {
          if (node.id === inputEdge.from || node.id === inputEdge.to) continue
          const crossesInterior = previous.y === point.y
            ? node.x < Math.max(previous.x, point.x) &&
              Math.min(previous.x, point.x) < node.x + node.width &&
              node.y < point.y &&
              point.y < node.y + node.height
            : node.y < Math.max(previous.y, point.y) &&
              Math.min(previous.y, point.y) < node.y + node.height &&
              node.x < point.x &&
              point.x < node.x + node.width
          if (crossesInterior) edgeNodeIntersections += 1
        }
      }
    }
    expect(edgeNodeIntersections).toBe(0)
  }, 15_000)
})
