import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphNode, Subgraph } from '../types'
import { MAX_GRAPH_EDGES, MAX_GRAPH_RENDER_NODES } from './graphLimits'
import {
  clearLayoutGeometryCache,
  controlRoleForPin,
  fitViewportToContent,
  interpretSchemWeaveResult,
  LAYOUT_GEOMETRY_CACHE_MAX_BYTES,
  LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES,
  layoutSubgraph,
  nodeDimensions,
  panViewport,
  prewarmLayoutWorker,
  preserveViewportAnchor,
  prepareLayoutInput,
  toSchemWeaveGraph,
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

  it('gives carry and DSP primitives distinct hard-block proportions', () => {
    expect(nodeDimensions(node(1, 'CARRY8'))).toEqual({ width: 98, height: 58 })
    expect(nodeDimensions(node(2, 'DSP48E2'))).toEqual({ width: 112, height: 62 })
    expect(nodeDimensions(node(3, 'SB_MAC16'))).toEqual({ width: 112, height: 62 })
  })

  it('sizes Vivado implementation cells from the readable RTL-facing name', () => {
    expect(nodeDimensions(node(1, 'LUT1', {
      name: 'one_hot_OBUF[23]_inst_i_6_2',
    }))).toEqual({ width: 103, height: 54 })
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

  it('passes per-symbol dimensions to SchemWeave', () => {
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
    const graph = toSchemWeaveGraph(prepareLayoutInput(sub))
    expect(graph.nodes.map(({ width, height }) => ({ width, height }))).toEqual([
      nodeDimensions(sub.nodes[0]),
      nodeDimensions(sub.nodes[1]),
    ])
  })

  it('maps flip-flop data and control edges to their exact rendered pins', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, '$_MUX_', { seq: false }),
        node(2, '$_DFFSR_PPP_', { seq: true }),
        node(3, 'port', { kind: 'port' }),
        node(4, 'port', { kind: 'port' }),
        node(5, 'port', { kind: 'port' }),
      ],
      edges: [
        { from: 1, to: 2, from_port: 'Y', to_port: 'D', net_name: 'd', bits: [0] },
        { from: 2, to: 3, from_port: 'Q', to_port: 'A', net_name: 'q', bits: [0] },
        { from: 4, to: 2, from_port: 'clk', to_port: 'C', net_name: 'clk', bits: [0], control: true },
        { from: 5, to: 2, from_port: 'rst', to_port: 'R', net_name: 'rst', bits: [0], control: true },
      ],
      truncated: false,
    }
    const graph = toSchemWeaveGraph(prepareLayoutInput(sub))
    const reg = graph.nodes.find((candidate) => candidate.id === 2)!
    expect(reg.cycle_breaker).toBe(true)
    expect(reg.ports).toEqual([
      { id: 0, side: 'west', offset: 58 * 0.32 },
      { id: 1, side: 'west', offset: 58 * 0.5 },
      { id: 2, side: 'west', offset: 58 * 0.72 },
      { id: 3, side: 'east', offset: 58 * 0.5 },
    ])
    expect(graph.edges.map(({ source, target }) => ({ source, target }))).toEqual([
      { source: { node: 1, port: 0 }, target: { node: 2, port: 0 } },
      { source: { node: 2, port: 3 }, target: { node: 3, port: 0 } },
      { source: { node: 4, port: 0 }, target: { node: 2, port: 2 } },
      { source: { node: 5, port: 0 }, target: { node: 2, port: 1 } },
    ])
  })

  it('uses stable sorted primitive pins and groups fanout by electrical source pin', () => {
    const sub: Subgraph = {
      nodes: [
        node(1, 'port', { kind: 'port' }),
        node(2, 'port', { kind: 'port' }),
        node(3, 'port', { kind: 'port' }),
        node(4, 'RAM32M', { seq: true, register: false }),
        node(5, 'port', { kind: 'port' }),
        node(6, 'port', { kind: 'port' }),
      ],
      edges: [
        { from: 1, to: 4, from_port: 'we', to_port: 'WE', net_name: 'we', bits: [1] },
        { from: 2, to: 4, from_port: 'addr', to_port: 'ADDR', net_name: 'addr', bits: [2] },
        { from: 3, to: 4, from_port: 'wdata', to_port: 'WDATA', net_name: 'wdata', bits: [3] },
        { from: 4, to: 5, from_port: 'RDATA', to_port: 'q', net_name: 'rdata', bits: [4] },
        { from: 4, to: 6, from_port: 'RDATA', to_port: 'q', net_name: 'alias', bits: [4] },
      ],
      truncated: false,
    }

    const graph = toSchemWeaveGraph(prepareLayoutInput(sub))
    const ram = graph.nodes.find((candidate) => candidate.id === 4)!
    expect(ram.ports).toEqual([
      { id: 0, side: 'west', offset: 15.5 },
      { id: 1, side: 'west', offset: 31 },
      { id: 2, side: 'west', offset: 46.5 },
      { id: 3, side: 'east', offset: 31 },
    ])
    expect(graph.edges.slice(-2).map((edge) => edge.net)).toEqual([3, 3])
    expect(graph.edges.every((edge) => edge.participates_in_ranking)).toBe(true)
  })

  it('shares trunks only for edges carrying the same electrical bit set', () => {
    const graph = toSchemWeaveGraph(prepareLayoutInput({
      nodes: [
        node(1, '$_BUF_'),
        node(2, 'port', { kind: 'port' }),
        node(3, 'port', { kind: 'port' }),
        node(4, 'port', { kind: 'port' }),
      ],
      edges: [
        { from: 1, to: 2, from_port: 'Y', to_port: 'A', net_name: 'sum[0]', bits: [101, 103] },
        { from: 1, to: 3, from_port: 'Y', to_port: 'A', net_name: 'sum[1]', bits: [102] },
        { from: 1, to: 4, from_port: 'Y', to_port: 'A', net_name: 'sum_alias', bits: [103, 101] },
      ],
      truncated: false,
    }))

    expect(graph.edges.map((edge) => edge.net)).toEqual([0, 1, 0])
  })

  it('marks every sequential storage boundary as a cycle breaker', () => {
    const graph = toSchemWeaveGraph(prepareLayoutInput({
      nodes: [
        node(1, 'RAM32M', { seq: true, register: false }),
        node(2, 'SRL16E', { seq: true, register: false }),
        node(3, 'blackbox', { seq: true, register: false }),
        node(4, '$_AND_', { seq: false }),
      ],
      edges: [],
      truncated: false,
    }))

    expect(graph.nodes.map((candidate) => candidate.cycle_breaker)).toEqual([
      true,
      true,
      true,
      false,
    ])
  })

  it('preserves SchemWeave edge identity when adapting WASM output', () => {
    expect(interpretSchemWeaveResult({
      nodes: [{ id: 2, x: 100, y: 20, width: 76, height: 52 }],
      edges: [{ id: 7, points: [{ x: 0, y: 10 }, { x: 100, y: 10 }] }],
      width: 176,
      height: 72,
    })).toEqual({
      nodes: [{ id: 2, x: 100, y: 20, width: 76, height: 52 }],
      edges: [{ inputIndex: 7, points: [{ x: 0, y: 10 }, { x: 100, y: 10 }] }],
      width: 176,
      height: 72,
    })
  })

  it('enforces the 2000-node renderer cap before starting layout', async () => {
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

  it('enforces the shared 10000 merged-edge cap before starting layout', async () => {
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

  it('evicts at the cumulative byte budget before reaching the entry bound', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const pointsPerEntry = Math.ceil(
      (LAYOUT_GEOMETRY_CACHE_MAX_BYTES / LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1) / 48,
    )
    const subgraphFor = (index: number): Subgraph => ({
      nodes: [node(index * 2, '$_BUF_'), node(index * 2 + 1, '$_BUF_')],
      edges: [{
        from: index * 2,
        to: index * 2 + 1,
        from_port: 'Y',
        to_port: 'A',
        net_name: `route-${index}`,
        bits: [index],
      }],
      truncated: false,
    })
    const geometryFor = (index: number, large: boolean) => ({
      nodes: [
        { id: index * 2, x: 0, y: 0, width: 62, height: 46 },
        { id: index * 2 + 1, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{
        inputIndex: 0,
        points: large
          ? Array(pointsPerEntry).fill({ x: 0, y: 0 })
          : [{ x: 62, y: 23 }, { x: 128, y: 23 }],
      }],
      width: 190,
      height: 46,
    })

    for (let index = 1; index <= LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES; index += 1) {
      const pendingLayout = layoutSubgraph(subgraphFor(index))
      const instance = FakeWorker.instances[0]
      const request = instance.requests.at(-1)!
      instance.onmessage?.({
        data: { id: request.id, ok: true, result: geometryFor(index, true) },
      } as MessageEvent)
      await pendingLayout
    }

    const instance = FakeWorker.instances[0]
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES)
    const evicted = layoutSubgraph(subgraphFor(1))
    expect(instance.requests).toHaveLength(LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES + 1)
    const request = instance.requests.at(-1)!
    instance.onmessage?.({
      data: { id: request.id, ok: true, result: geometryFor(1, false) },
    } as MessageEvent)
    await evicted
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

  it('surfaces a layout failure without caching partial geometry', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sub = workerSubgraph()
    const pendingLayout = layoutSubgraph(sub)
    const instance = FakeWorker.instances[0]
    const first = instance.requests[0]
    instance.onmessage?.({
      data: { id: first.id, ok: false, error: 'invalid layout graph' },
    } as MessageEvent)
    await expect(pendingLayout).rejects.toThrow('invalid layout graph')
    expect(instance.requests).toHaveLength(1)

    const retried = layoutSubgraph(sub)
    const retry = instance.requests[1]
    instance.onmessage?.({
      data: { id: retry.id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(retried).resolves.toMatchObject({ width: 76, height: 66 })
    instance.onerror?.({ message: 'cleanup' } as ErrorEvent)
  })

  it('uses a fresh worker for the next request after a worker crash', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const pendingLayout = layoutSubgraph(workerSubgraph())
    const first = FakeWorker.instances[0]
    first.onerror?.({ message: 'worker crashed' } as ErrorEvent)
    await expect(pendingLayout).rejects.toThrow('worker crashed')
    expect(first.terminate).toHaveBeenCalledOnce()

    const nextLayout = layoutSubgraph(workerSubgraph())
    const replacement = FakeWorker.instances[1]
    replacement.onmessage?.({
      data: { id: replacement.requests[0].id, ok: true, result: geometry },
    } as MessageEvent)
    await expect(nextLayout).resolves.toMatchObject({ width: 76 })
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
