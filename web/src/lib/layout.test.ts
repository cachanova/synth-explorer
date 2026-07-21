import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import { MAX_GRAPH_EDGES, MAX_GRAPH_RENDER_NODES } from './graphLimits'
import {
  clearLayoutGeometryCache,
  controlRoleForPin,
  fitViewportToContent,
  hydrateLayoutResult,
  interpretResult,
  LAYOUT_GEOMETRY_CACHE_MAX_BYTES,
  LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES,
  layoutSubgraph,
  NETWORK_SIMPLEX_EDGE_LIMIT,
  NETWORK_SIMPLEX_NODE_LIMIT,
  nodeDimensions,
  panViewport,
  placementForLayout,
  prewarmLayoutWorker,
  preserveViewportAnchor,
  prepareLayoutInput,
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
  it('classifies vendor memory clock pin spellings as clocks', () => {
    for (const pin of ['WCLK', 'RCLK', 'CLKA', 'CLKB', 'CLKARDCLK']) {
      expect(controlRoleForPin(pin)).toBe('clock')
    }
  })

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
    const graph = toElkGraph(prepareLayoutInput(sub))
    expect(graph.children?.map(({ width, height }) => ({ width, height }))).toEqual([
      nodeDimensions(sub.nodes[0]),
      nodeDimensions(sub.nodes[1]),
    ])
    expect(graph.layoutOptions?.['elk.edgeRouting']).toBe('ORTHOGONAL')
  })

  it('reduces ELK thoroughness only on the robust large-graph placement path', () => {
    const input = prepareLayoutInput({
      nodes: [node(1, '$_AND_'), node(2, '$_OR_')],
      edges: [
        {
          from: 1,
          to: 2,
          from_port: 'Y',
          to_port: 'A',
          net_name: 'n1',
          bits: [1],
        },
      ],
      truncated: false,
    })

    expect(
      toElkGraph(input, 'NETWORK_SIMPLEX').layoutOptions?.[
        'elk.layered.thoroughness'
      ],
    ).toBeUndefined()
    expect(
      toElkGraph(input, 'BRANDES_KOEPF').layoutOptions?.[
        'elk.layered.thoroughness'
      ],
    ).toBe('4')
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
    const graph = toElkGraph(prepareLayoutInput(sub))
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

  it('routes every primitive edge to its sorted named pin, including fallback paths', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', { kind: 'port' }),
        node(2, 'port', { kind: 'port' }),
        node(3, 'port', { kind: 'port' }),
        node(4, 'RAM32M', {
          seq: true,
          register: false,
          controls: [
            { role: 'clock', pin: 'WCLK', net_name: 'clk', driver_id: 8, fanout: 1 },
          ],
        }),
        node(5, 'port', { kind: 'port' }),
      ],
      // Deliberately not alphabetical: rendering and fallback routing must use
      // the same canonical order as the fixed ELK ports.
      edges: [
        { from: 1, to: 4, from_port: 'we', to_port: 'WE', net_name: 'we', bits: [1] },
        { from: 2, to: 4, from_port: 'addr', to_port: 'ADDR', net_name: 'addr', bits: [2] },
        { from: 3, to: 4, from_port: 'wdata', to_port: 'WDATA', net_name: 'wdata', bits: [3] },
        { from: 4, to: 5, from_port: 'RDATA', to_port: 'q', net_name: 'rdata', bits: [4] },
      ],
      truncated: false,
    }

    const elk = toElkGraph(prepareLayoutInput(sub))
    const ram = elk.children?.find((child) => child.id === '4')
    expect(ram?.ports?.map((port) => port.id)).toEqual([
      '4#i:ADDR',
      '4#i:WDATA',
      '4#i:WE',
      '4#o:RDATA',
    ])
    expect(ram?.height).toBe(75)
    expect(ram?.ports?.map((port) => port.y)).toEqual([15.5, 31, 46.5, 31])

    const laidOut = hydrateLayoutResult(sub, interpretResult(prepareLayoutInput(sub), {
      id: 'root',
      width: 500,
      height: 220,
      children: [
        { id: '1', x: 0, y: 0, width: 74, height: 34 },
        { id: '2', x: 0, y: 60, width: 74, height: 34 },
        { id: '3', x: 0, y: 120, width: 74, height: 34 },
        { id: '4', x: 200, y: 80, width: 112, height: 75 },
        { id: '5', x: 420, y: 90, width: 74, height: 34 },
      ],
      edges: [],
    }))
    expect(Object.fromEntries(
      laidOut.edges.slice(0, 3).map((edge) => [edge.edge.to_port, edge.points[1]]),
    )).toEqual({
      ADDR: { x: 200, y: 95.5 },
      WDATA: { x: 200, y: 111 },
      WE: { x: 200, y: 126.5 },
    })
    expect(laidOut.edges[3].points[1]).toEqual({ x: 420, y: 107 })
    expect(laidOut.edges[3].points[0]).toEqual({ x: 312, y: 111 })
  })

  it('routes visible clock and reset edges to their flip-flop pins', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', { kind: 'port' }),
        node(2, 'port', { kind: 'port' }),
        node(3, '$_DFFSR_PPP_', {
          seq: true,
          controls: [
            // Routing follows the actual edge pin even if optional display
            // metadata is stale or malformed.
            { role: 'reset', pin: 'C', net_name: 'clk', driver_id: 1, fanout: 1 },
            { role: 'clock', pin: 'R', net_name: 'rst', driver_id: 2, fanout: 1 },
          ],
        }),
      ],
      edges: [
        {
          from: 1,
          to: 3,
          from_port: 'clk',
          to_port: 'C',
          net_name: 'clk',
          bits: [0],
          control: true,
        },
        {
          from: 2,
          to: 3,
          from_port: 'rst',
          to_port: 'R',
          net_name: 'rst',
          bits: [0],
          control: true,
        },
      ],
      truncated: false,
    }

    const graph = toElkGraph(prepareLayoutInput(sub))
    const reg = graph.children?.find((child) => child.id === '3')
    const ports = new Map(reg?.ports?.map((port) => [port.id, port]))

    expect(graph.edges?.map((edge) => edge.targets)).toEqual([
      ['3#control:C'],
      ['3#control:R'],
    ])
    expect(ports.get('3#control:C')?.y).toBeCloseTo(58 * 0.72)
    expect(ports.get('3#control:R')?.y).toBeCloseTo(58 * 0.5)

    const laidOut = hydrateLayoutResult(sub, interpretResult(prepareLayoutInput(sub), {
      id: 'root',
      width: 260,
      height: 140,
      children: [
        { id: '1', x: 10, y: 10, width: 74, height: 34 },
        { id: '2', x: 10, y: 90, width: 74, height: 34 },
        { id: '3', x: 160, y: 40, width: 92, height: 84 },
      ],
      edges: [],
    }))
    expect(laidOut.edges[0].points[1]).toEqual({ x: 160, y: 40 + 58 * 0.72 })
    expect(laidOut.edges[1].points[1]).toEqual({ x: 160, y: 40 + 58 * 0.5 })
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

    const laidOut = hydrateLayoutResult(sub, interpretResult(prepareLayoutInput(sub), root))

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
      toElkGraph(prepareLayoutInput(sub)).layoutOptions?.[
        'elk.layered.nodePlacement.strategy'
      ],
    ).toBe('NETWORK_SIMPLEX')
    expect(
      toElkGraph(prepareLayoutInput(sub), 'BRANDES_KOEPF').layoutOptions?.[
        'elk.layered.nodePlacement.strategy'
      ],
    ).toBe('BRANDES_KOEPF')
    const graph = toElkGraph(prepareLayoutInput(sub))
    expect(graph.layoutOptions).not.toHaveProperty('elk.interactive')
    expect(graph.children?.[0]).not.toHaveProperty('x')
    expect(graph.children?.[0]).not.toHaveProperty('y')
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

  class FakeWorker {
      static instances: FakeWorker[] = []
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      terminate = vi.fn()
      requests: Array<{
        id: number
        input: ReturnType<typeof prepareLayoutInput>
        placement: 'NETWORK_SIMPLEX' | 'BRANDES_KOEPF'
      }> = []

      constructor() {
        FakeWorker.instances.push(this)
      }

      postMessage(request: FakeWorker['requests'][number]) {
        this.requests.push(request)
      }
    }

  const workerSubgraph = (id = 1): Subgraph => ({
    nodes: [node(id, '$_AND_', { members: [1, 2], params: { secret: 'resident' } })],
    edges: [],
    truncated: false,
  })

  const geometry = {
    nodes: [{ id: 1, x: 0, y: 0, width: 76, height: 66 }],
    edges: [],
    width: 76,
    height: 66,
  }

  afterEach(() => {
    clearLayoutGeometryCache()
    FakeWorker.instances = []
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('prewarms one worker without posting layout work', () => {
    vi.stubGlobal('Worker', FakeWorker)

    prewarmLayoutWorker()
    prewarmLayoutWorker()

    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0].requests).toEqual([])
    FakeWorker.instances[0].onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('recreates a worker that crashes during otherwise-idle prewarm', async () => {
    vi.stubGlobal('Worker', FakeWorker)

    prewarmLayoutWorker()
    const crashed = FakeWorker.instances[0]
    crashed.onerror?.({ message: 'warmup crashed' } as ErrorEvent)
    expect(crashed.terminate).toHaveBeenCalledOnce()

    const pending = layoutSubgraph(workerSubgraph())
    const replacement = FakeWorker.instances[1]
    expect(replacement.requests).toHaveLength(1)
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(pending).resolves.toMatchObject({ width: 76 })
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('sends compact layout input and terminates a superseded worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()
    const controller = new AbortController()

    const superseded = layoutSubgraph(sub, controller.signal)
    const first = FakeWorker.instances[0]
    expect(first.requests[0]).toEqual({
      id: expect.any(Number),
      input: prepareLayoutInput(sub),
      placement: 'NETWORK_SIMPLEX',
    })
    expect(first.requests[0].input.nodes[0]).not.toHaveProperty('members')
    expect(first.requests[0].input.nodes[0]).not.toHaveProperty('params')
    controller.abort()
    await expect(superseded).rejects.toMatchObject({ name: 'AbortError' })
    expect(first.terminate).toHaveBeenCalledOnce()

    const current = layoutSubgraph(sub)
    const second = FakeWorker.instances[1]
    const request = second.requests[0]
    second.onmessage?.({
      data: { id: request.id, ok: true, result: geometry },
    } as MessageEvent)
    const result = await current
    expect(result.nodes[0].node).toBe(sub.nodes[0])
    expect(FakeWorker.instances).toHaveLength(2)
    second.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('reuses completed geometry for an equivalent fresh subgraph', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const firstSubgraph: Subgraph = {
      nodes: [node(1, '$_BUF_'), node(2, '$_BUF_')],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'A',
        net_name: 'first',
        bits: [1],
      }],
      truncated: false,
    }
    const edgeGeometry = {
      nodes: [
        { id: 1, x: 0, y: 0, width: 62, height: 46 },
        { id: 2, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{ inputIndex: 0, points: [{ x: 62, y: 23 }, { x: 128, y: 23 }] }],
      width: 190,
      height: 46,
    }
    const firstLayout = layoutSubgraph(firstSubgraph)
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: edgeGeometry },
    } as MessageEvent)
    await firstLayout

    const equivalent: Subgraph = structuredClone(firstSubgraph)
    equivalent.nodes[0] = { ...equivalent.nodes[0], src: 'current.sv:9.1-9.2' }
    equivalent.edges[0] = { ...equivalent.edges[0], net_name: 'current' }
    const cached = await layoutSubgraph(equivalent)

    expect(instance.requests).toHaveLength(1)
    expect(cached.nodes[0].node).toBe(equivalent.nodes[0])
    expect(cached.edges[0].edge).toBe(equivalent.edges[0])

    const changedPort: Subgraph = structuredClone(equivalent)
    changedPort.edges[0].to_port = 'B'
    const changedLayout = layoutSubgraph(changedPort)
    expect(instance.requests).toHaveLength(2)
    instance.onmessage?.({
      data: { id: instance.requests[1].id, ok: true, result: edgeGeometry },
    } as MessageEvent)
    await changedLayout
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('does not reuse geometry when compact layout input changes', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const firstLayout = layoutSubgraph(workerSubgraph())
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await firstLayout

    const changed = workerSubgraph()
    changed.nodes[0] = node(1, '$_DFF_P_')
    const changedLayout = layoutSubgraph(changed)
    expect(instance.requests).toHaveLength(2)
    expect(instance.requests[1].input.nodes[0].register).toBe(true)
    instance.onmessage?.({
      data: {
        id: instance.requests[1].id,
        ok: true,
        result: geometry,
      },
    } as MessageEvent)
    await expect(changedLayout).resolves.toMatchObject({ width: 76 })
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('does not retain one geometry estimate above the byte budget', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const subgraph: Subgraph = {
      nodes: [node(1, '$_BUF_'), node(2, '$_BUF_')],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'Y',
        to_port: 'A',
        net_name: 'wide-route',
        bits: [1],
      }],
      truncated: false,
    }
    const oversizedGeometry = {
      nodes: [
        { id: 1, x: 0, y: 0, width: 62, height: 46 },
        { id: 2, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{
        inputIndex: 0,
        points: Array(Math.ceil(LAYOUT_GEOMETRY_CACHE_MAX_BYTES / 48) + 1)
          .fill({ x: 0, y: 0 }),
      }],
      width: 190,
      height: 46,
    }
    const first = layoutSubgraph(subgraph)
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: oversizedGeometry },
    } as MessageEvent)
    await first

    const repeated = layoutSubgraph(structuredClone(subgraph))
    expect(instance.requests).toHaveLength(2)
    instance.onmessage?.({
      data: {
        id: instance.requests[1].id,
        ok: true,
        result: {
          ...oversizedGeometry,
          edges: [{
            inputIndex: 0,
            points: [{ x: 62, y: 23 }, { x: 128, y: 23 }],
          }],
        },
      },
    } as MessageEvent)
    await expect(repeated).resolves.toMatchObject({ width: 190, height: 46 })
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('keeps cached hits abortable without starting worker work', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const firstLayout = layoutSubgraph(workerSubgraph())
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await firstLayout

    const controller = new AbortController()
    controller.abort()
    await expect(layoutSubgraph(workerSubgraph(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(instance.requests).toHaveLength(1)
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('promotes hits and evicts least-recently-used geometry at the entry bound', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    for (let id = 1; id <= LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES; id += 1) {
      const pendingLayout = layoutSubgraph(workerSubgraph(id))
      const instance = FakeWorker.instances[0]
      const request = instance.requests.at(-1)!
      instance.onmessage?.({
        data: {
          id: request.id,
          ok: true,
          result: {
            ...geometry,
            nodes: [{ ...geometry.nodes[0], id }],
          },
        },
      } as MessageEvent)
      await pendingLayout
    }

    const instance = FakeWorker.instances[0]
    await layoutSubgraph(workerSubgraph(1))
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES)

    const fifth = layoutSubgraph(workerSubgraph(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1))
    const request = instance.requests.at(-1)!
    instance.onmessage?.({
      data: {
        id: request.id,
        ok: true,
        result: {
          ...geometry,
          nodes: [{ ...geometry.nodes[0], id: LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1 }],
        },
      },
    } as MessageEvent)
    await fifth

    await layoutSubgraph(workerSubgraph(1))
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1)
    const secondAgain = layoutSubgraph(workerSubgraph(2))
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 2)
    const secondRequest = instance.requests.at(-1)!
    instance.onmessage?.({
      data: {
        id: secondRequest.id,
        ok: true,
        result: {
          ...geometry,
          nodes: [{ ...geometry.nodes[0], id: 2 }],
        },
      },
    } as MessageEvent)
    await secondAgain
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('retries a failed tight layout with the same compact input', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()
    const pendingLayout = layoutSubgraph(sub)
    const instance = FakeWorker.instances[0]
    const first = instance.requests[0]
    instance.onmessage?.({
      data: { id: first.id, ok: false, error: 'stack overflow' },
    } as MessageEvent)
    await vi.waitFor(() => expect(instance.requests).toHaveLength(2))
    const retry = instance.requests[1]
    expect(retry.placement).toBe('BRANDES_KOEPF')
    expect(retry.input).toEqual(first.input)
    instance.onmessage?.({
      data: { id: retry.id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(pendingLayout).resolves.toMatchObject({ width: 76, height: 66 })

    const repeated = layoutSubgraph(workerSubgraph())
    expect(instance.requests).toHaveLength(3)
    expect(instance.requests[2].placement).toBe('NETWORK_SIMPLEX')
    instance.onmessage?.({
      data: { id: instance.requests[2].id, ok: false, error: 'stack overflow' },
    } as MessageEvent)
    await expect(repeated).resolves.toMatchObject({ width: 76, height: 66 })
    expect(instance.requests).toHaveLength(3)
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('recovers from a worker crash using a fresh worker', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const pendingLayout = layoutSubgraph(workerSubgraph())
    const first = FakeWorker.instances[0]
    first.onerror?.({ message: 'worker crashed' } as ErrorEvent)
    await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2))
    const replacement = FakeWorker.instances[1]
    expect(replacement.requests[0].placement).toBe('BRANDES_KOEPF')
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(pendingLayout).resolves.toMatchObject({ width: 76 })
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('reuses the warm worker after an independent successful layout', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const firstLayout = layoutSubgraph(workerSubgraph())
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await firstLayout

    const secondLayout = layoutSubgraph(workerSubgraph(2))
    expect(FakeWorker.instances).toHaveLength(1)
    expect(instance.requests).toHaveLength(2)
    instance.onmessage?.({
      data: {
        id: instance.requests[1].id,
        ok: true,
        result: {
          ...geometry,
          nodes: [{ ...geometry.nodes[0], id: 2 }],
        },
      },
    } as MessageEvent)
    await secondLayout
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('times out without retrying and lets the next layout use a fresh worker', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    const timedOut = layoutSubgraph(workerSubgraph())
    const first = FakeWorker.instances[0]
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({
      name: 'LayoutTimeoutError',
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await timeoutExpectation
    expect(first.requests).toHaveLength(1)
    expect(first.terminate).toHaveBeenCalledOnce()

    const current = layoutSubgraph(workerSubgraph())
    const replacement = FakeWorker.instances[1]
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(current).resolves.toMatchObject({ width: 76 })
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('rejects every pending request when the shared worker times out', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    const firstLayout = layoutSubgraph(workerSubgraph())
    const secondLayout = layoutSubgraph(workerSubgraph())
    const firstExpectation = expect(firstLayout).rejects.toMatchObject({
      name: 'LayoutTimeoutError',
    })
    const secondExpectation = expect(secondLayout).rejects.toMatchObject({
      name: 'LayoutTimeoutError',
    })
    const instance = FakeWorker.instances[0]
    expect(instance.requests).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.all([firstExpectation, secondExpectation])
    expect(instance.terminate).toHaveBeenCalledOnce()

    const replacementLayout = layoutSubgraph(workerSubgraph())
    const replacement = FakeWorker.instances[1]
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await replacementLayout
    replacement.onerror?.({ message: 'cleanup' } as ErrorEvent)
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

  it('preserves a retained anchor on screen without changing zoom', () => {
    const graphNode = node(1, '$_AND_')
    const previous = {
      nodes: [{ id: 1, x: 20, y: 30, width: 80, height: 50, node: graphNode }],
      edges: [],
      width: 100,
      height: 80,
    }
    const next = {
      ...previous,
      nodes: [{ ...previous.nodes[0], x: 120, y: 70 }],
    }

    expect(
      preserveViewportAnchor({ x: 10, y: 15, k: 2 }, previous, next, [1]),
    ).toEqual({ x: -190, y: -65, k: 2 })
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
