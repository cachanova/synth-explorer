import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import { MAX_GRAPH_EDGES, MAX_GRAPH_RENDER_NODES } from './graphLimits'
import {
  layoutSubgraph,
  nodeDimensions,
  panViewport,
  toElkGraph,
  viewportTransformAttribute,
  zoomViewportAt,
} from './layout'

const node = (id: number, cellType: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'cell',
  name: `u${id}`,
  cell_type: cellType,
  ...extra,
})

describe('schematic layout sizing', () => {
  it('gives gates compact schematic proportions', () => {
    expect(nodeDimensions(node(1, '$_AND_'))).toEqual({ width: 76, height: 52 })
  })

  it('reserves register space for compact control-net labels', () => {
    const plain = nodeDimensions(node(1, 'FDRE'))
    const controlledNode = node(2, 'FDRE')
    controlledNode.controls = [
      { role: 'clock', pin: 'C', net_name: 'sys_clk', driver_id: 8, fanout: 2 },
      { role: 'reset', pin: 'R', net_name: 'rst_n', driver_id: 9, fanout: 2 },
    ]
    const controlled = nodeDimensions(controlledNode)
    expect(controlled.height).toBeGreaterThan(plain.height)
    expect(controlled.width).toBeGreaterThanOrEqual(plain.width)
  })

  it('reserves one row for every label-connected control', () => {
    const controlledNode = node(2, 'FDRE', {
      controls: [
        { role: 'clock', pin: 'C', net_name: 'clk', driver_id: 8, fanout: 2 },
        { role: 'reset', pin: 'R', net_name: 'rst', driver_id: 9, fanout: 2 },
        { role: 'enable', pin: 'CE', net_name: 'ce', driver_id: 10, fanout: 2 },
        { role: 'set', pin: 'S', net_name: 'set', driver_id: 11, fanout: 2 },
      ],
    })

    expect(nodeDimensions(controlledNode).height).toBe(58 + 4 * 13)

    const controlledSrl = node(3, 'SRL16E', {
      register: false,
      seq: true,
      controls: [
        { role: 'clock', pin: 'CLK', net_name: 'clk', driver_id: 8, fanout: 2 },
      ],
    })
    expect(nodeDimensions(controlledSrl).height).toBe(62 + 13)
  })

  it('passes per-symbol dimensions to bounded ELK layout', () => {
    const sub: Subgraph = {
      nodes: [node(1, '$_XOR_'), node(2, '$mem_v2', { is_boundary: true })],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'Y',
          to_port: 'D',
          net_name: 'result',
          bits: [1],
        },
      ],
      truncated: false,
    }
    const graph = toElkGraph(sub)
    expect(graph.children?.map(({ width, height }) => ({ width, height }))).toEqual([
      nodeDimensions(sub.nodes[0]),
      nodeDimensions(sub.nodes[1]),
    ])
    expect(graph.layoutOptions?.['elk.edgeRouting']).toBe('ORTHOGONAL')
  })

  it('enforces the 2000-node renderer cap before starting ELK', async () => {
    expect(MAX_GRAPH_RENDER_NODES).toBe(2000)
    const oversized: Subgraph = {
      nodes: Array.from({ length: MAX_GRAPH_RENDER_NODES + 1 }, (_, index) =>
        node(index, '$_AND_'),
      ),
      edges: [],
      truncated: true,
    }

    await expect(layoutSubgraph(oversized)).rejects.toThrow('cone too large')
  })

  it('enforces the shared 10000 merged-edge cap before starting ELK', async () => {
    expect(MAX_GRAPH_EDGES).toBe(10_000)
    const edge = {
      from: 1,
      to: 2,
      from_port: 'Y',
      to_port: 'A',
      net_name: 'dense',
      bits: [1],
    }
    const oversized: Subgraph = {
      nodes: [node(1, '$_BUF_'), node(2, '$_BUF_')],
      edges: Array.from({ length: MAX_GRAPH_EDGES + 1 }, () => edge),
      truncated: true,
    }

    await expect(layoutSubgraph(oversized)).rejects.toThrow(
      '10001 merged edges; limit 10000',
    )
  })
})

describe('viewport transforms', () => {
  it('pans without changing scale and emits the SVG transform', () => {
    const moved = panViewport({ x: 10, y: 20, k: 2 }, 5, -7)
    expect(moved).toEqual({ x: 15, y: 13, k: 2 })
    expect(viewportTransformAttribute(moved)).toBe('translate(15,13) scale(2)')
  })

  it('zooms around a fixed screen-space anchor and clamps scale', () => {
    const previous = { x: 10, y: 20, k: 1 }
    const zoomed = zoomViewportAt(previous, 110, 70, 2)
    expect(zoomed).toEqual({ x: -90, y: -30, k: 2 })
    expect((110 - zoomed.x) / zoomed.k).toBe((110 - previous.x) / previous.k)
    expect((70 - zoomed.y) / zoomed.k).toBe((70 - previous.y) / previous.k)
    expect(zoomViewportAt(previous, 0, 0, 100).k).toBe(4)
    expect(zoomViewportAt(previous, 0, 0, 0.001).k).toBe(0.08)
  })
})
