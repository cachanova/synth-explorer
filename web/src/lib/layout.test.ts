import { describe, expect, it } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import { MAX_GRAPH_EDGES, MAX_GRAPH_RENDER_NODES } from './graphLimits'
import {
  fitViewportToContent,
  interpretResult,
  layoutSubgraph,
  NETWORK_SIMPLEX_EDGE_LIMIT,
  NETWORK_SIMPLEX_NODE_LIMIT,
  nodeDimensions,
  panViewport,
  placementForLayout,
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

  it('adds a badge row and width for grouped vector nodes', () => {
    const plain = nodeDimensions(node(1, 'FDRE'))
    const grouped = nodeDimensions(
      node(2, 'FDRE', { width: 8, members: [1, 2, 3, 4, 5, 6, 7, 8] }),
    )
    // A grouped node reserves an extra row for its "×N" badge.
    expect(grouped.height).toBe(plain.height + 14)
    expect(grouped.width).toBeGreaterThanOrEqual(plain.width)
    // A single-bit node (width 1) is not treated as grouped.
    expect(nodeDimensions(node(3, 'FDRE', { width: 1 }))).toEqual(plain)
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

  it('routes flip-flop data edges to D and Q ports, not the box centre', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, '$_MUX_', { seq: false }),
        node(2, '$_DFF_P_', { seq: true }),
        node(3, 'port', { kind: 'port' }),
      ],
      edges: [
        { from: 1, to: 2, from_port: 'Y', to_port: 'D', net_name: 'd', bits: [0] },
        { from: 2, to: 3, from_port: 'Q', to_port: 'A', net_name: 'q', bits: [0] },
      ],
      truncated: false,
    }
    const graph = toElkGraph(sub)
    const reg = graph.children?.find((c) => c.id === '2')
    expect(reg?.ports?.map((p) => p.id)).toEqual(['2#in', '2#out'])
    expect(reg?.layoutOptions?.['elk.portConstraints']).toBe('FIXED_POS')
    // the D edge targets the register's in-port; the Q edge leaves its out-port
    expect(graph.edges?.[0].targets).toEqual(['2#in'])
    expect(graph.edges?.[1].sources).toEqual(['2#out'])
    // non-register nodes now expose a fixed port per distinct pin, so their
    // edges route to spread-out pins rather than the box centre
    const mux = graph.children?.find((c) => c.id === '1')
    expect(mux?.ports?.map((p) => p.id)).toEqual(['1#o:Y'])
    expect(mux?.layoutOptions?.['elk.portConstraints']).toBe('FIXED_POS')
    expect(graph.edges?.[0].sources).toEqual(['1#o:Y'])
    // the sink port node routes the Q edge to its A input pin
    expect(graph.edges?.[1].targets).toEqual(['3#i:A'])
  })

  it('preserves register connectivity when ELK reorders or omits routed edges', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'CARRY4'),
        node(2, 'CARRY4'),
        node(3, 'FDRE', { seq: true, register: true }),
        node(4, 'port', { kind: 'port' }),
      ],
      edges: [
        {
          from: 1,
          to: 3,
          from_port: 'O',
          to_port: 'D',
          net_name: 'd[3:0]',
          bits: [0, 1, 2, 3],
        },
        {
          from: 2,
          to: 3,
          from_port: 'O',
          to_port: 'D',
          net_name: 'd[7:4]',
          bits: [4, 5, 6, 7],
        },
        {
          from: 3,
          to: 4,
          from_port: 'Q',
          to_port: 'q',
          net_name: 'q',
          bits: [0, 1, 2, 3, 4, 5, 6, 7],
        },
      ],
      truncated: false,
    }
    const root = {
      id: 'root',
      width: 500,
      height: 200,
      children: [
        { id: '1', x: 10, y: 20, width: 96, height: 54 },
        { id: '2', x: 10, y: 100, width: 96, height: 54 },
        { id: '3', x: 240, y: 60, width: 100, height: 58 },
        { id: '4', x: 420, y: 72, width: 74, height: 34 },
      ],
      // ELK is allowed to reorder its result and may omit a routed section.
      // e1 is absent here; the adapter must still return the real 2 -> 3 edge.
      edges: [
        {
          id: 'e2',
          sources: ['3#out'],
          targets: ['4#i:q'],
          sections: [
            {
              id: 'e2s0',
              startPoint: { x: 340, y: 89 },
              endPoint: { x: 420, y: 89 },
            },
          ],
        },
        {
          id: 'e0',
          sources: ['1#o:O'],
          targets: ['3#in'],
          sections: [
            {
              id: 'e0s0',
              startPoint: { x: 106, y: 47 },
              endPoint: { x: 240, y: 79 },
            },
          ],
        },
      ],
    }

    const laidOut = interpretResult(sub, root)

    expect(laidOut.edges.map(({ from, to }) => [from, to])).toEqual([
      [1, 3],
      [2, 3],
      [3, 4],
    ])
    expect(laidOut.edges.map(({ edge }) => edge.net_name)).toEqual([
      'd[3:0]',
      'd[7:4]',
      'q',
    ])
    expect(laidOut.edges[1].points).toEqual([
      { x: 106, y: 127 },
      { x: 240, y: 78.56 },
    ])
  })

  it('picks robust placement for large or dense graphs, tight for small', () => {
    const small: Subgraph = {
      nodes: [node(1, '$_AND_'), node(2, '$_AND_')],
      edges: [],
      truncated: false,
    }
    expect(placementForLayout(small)).toBe('NETWORK_SIMPLEX')

    const manyNodes: Subgraph = {
      nodes: Array.from({ length: NETWORK_SIMPLEX_NODE_LIMIT + 1 }, (_, i) =>
        node(i, '$_AND_'),
      ),
      edges: [],
      truncated: false,
    }
    expect(placementForLayout(manyNodes)).toBe('BRANDES_KOEPF')

    const denseEdges: Subgraph = {
      nodes: [node(1, '$_AND_'), node(2, '$_AND_')],
      edges: Array.from({ length: NETWORK_SIMPLEX_EDGE_LIMIT + 1 }, () => ({
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'A',
        net_name: 'n',
        bits: [1],
      })),
      truncated: false,
    }
    expect(placementForLayout(denseEdges)).toBe('BRANDES_KOEPF')
  })

  it('defaults to NETWORK_SIMPLEX but can request the robust placement', () => {
    const sub: Subgraph = { nodes: [node(1, '$_AND_')], edges: [], truncated: false }
    expect(
      toElkGraph(sub).layoutOptions?.['elk.layered.nodePlacement.strategy'],
    ).toBe('NETWORK_SIMPLEX')
    expect(
      toElkGraph(sub, 'BRANDES_KOEPF').layoutOptions?.[
        'elk.layered.nodePlacement.strategy'
      ],
    ).toBe('BRANDES_KOEPF')
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
  it('refits centered graph content when the containing pane changes size', () => {
    expect(fitViewportToContent(1000, 600, 800, 400)).toEqual({
      x: 20,
      y: 60,
      k: 1.2,
    })
    expect(fitViewportToContent(600, 400, 800, 400)).toEqual({
      x: 20,
      y: 60,
      k: 0.7,
    })
  })

  it('ignores transient hidden-pane measurements instead of corrupting the transform', () => {
    expect(fitViewportToContent(0, 0, 800, 400)).toBeNull()
    expect(fitViewportToContent(1000, 0, 800, 400)).toBeNull()
    expect(fitViewportToContent(Number.NaN, 600, 800, 400)).toBeNull()
  })

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
