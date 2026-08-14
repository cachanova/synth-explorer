import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphNode, Subgraph } from '../../types'
import {
  MAX_GRAPH_EDGES,
  MAX_GROUP_EXPANSION_RENDER_NODES,
} from './graphLimits'
import { prepareLayoutInput } from './elkGraph'
import {
  clearLayoutGeometryCache,
  LAYOUT_GEOMETRY_CACHE_MAX_BYTES,
  LAYOUT_GEOMETRY_CACHE_MAX_ENTRIES,
  layoutSubgraph,
  NETWORK_SIMPLEX_EDGE_LIMIT,
  NETWORK_SIMPLEX_NODE_LIMIT,
  placementForLayout,
  prewarmLayoutWorker,
} from './layoutClient'

const node = (id: number, cellType: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: 'cell',
  name: `u${id}`,
  cell_type: cellType,
  ...extra,
})

describe('schematic layout sizing', () => {
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

  it('enforces the bounded group-expansion renderer cap before starting ELK', async () => {
    expect(MAX_GROUP_EXPANSION_RENDER_NODES).toBe(4096)
    const oversized: Subgraph = {
      nodes: Array.from({ length: MAX_GROUP_EXPANSION_RENDER_NODES + 1 }, (_, index) =>
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

  it('normalizes boundary metadata for cache identity and invalidates changed mappings', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const bundled = (): Subgraph => ({
      nodes: [
        node(1, 'port', {
          kind: 'port',
          port_direction: 'input',
          boundary_members: [
            { member: 11, bit: 1 },
            { member: 10, bit: 0 },
          ],
        }),
        node(2, 'port', {
          kind: 'port',
          port_direction: 'output',
          boundary_members: [
            { member: 21, bit: 1 },
            { member: 20, bit: 0 },
          ],
        }),
      ],
      edges: [{
        from: 1,
        to: 2,
        from_port: 'a',
        to_port: 'A',
        net_name: 'a',
        bits: [100, 101],
        source_boundary_members: [
          { member: 11, net_bits: [101] },
          { member: 10, net_bits: [100] },
        ],
        target_boundary_members: [
          { member: 21, net_bits: [101] },
          { member: 20, net_bits: [100] },
        ],
      }],
      truncated: false,
    })
    const bundledGeometry = {
      nodes: [
        { id: 1, x: 0, y: 0, width: 62, height: 46 },
        { id: 2, x: 128, y: 0, width: 62, height: 46 },
      ],
      edges: [{ inputIndex: 0, points: [{ x: 62, y: 23 }, { x: 128, y: 23 }] }],
      width: 190,
      height: 46,
    }

    const first = layoutSubgraph(bundled())
    const instance = FakeWorker.instances[0]
    instance.onmessage?.({
      data: { id: instance.requests[0].id, ok: true, result: bundledGeometry },
    } as MessageEvent)
    await first
    expect(instance.requests[0].input.nodes[0].boundaryMembers).toEqual([
      { member: 10, bit: 0 },
      { member: 11, bit: 1 },
    ])

    const equivalent = bundled()
    equivalent.nodes[0].boundary_members = [
      { member: 10, bit: 0 },
      { member: 11, bit: 1 },
      { member: 10, bit: 0 },
    ]
    equivalent.edges[0].source_boundary_members = [
      { member: 10, net_bits: [100, 100] },
      { member: 11, net_bits: [101] },
    ]
    equivalent.edges[0].target_boundary_members = [
      { member: 20, net_bits: [100, 100] },
      { member: 21, net_bits: [101] },
    ]
    await layoutSubgraph(equivalent)
    expect(instance.requests).toHaveLength(1)

    const changedNode = bundled()
    changedNode.nodes[0].boundary_members![1].bit = 2
    const changedNodeLayout = layoutSubgraph(changedNode)
    expect(instance.requests).toHaveLength(2)
    instance.onmessage?.({
      data: { id: instance.requests[1].id, ok: true, result: bundledGeometry },
    } as MessageEvent)
    await changedNodeLayout

    const changedEdge = bundled()
    changedEdge.edges[0].target_boundary_members![1].net_bits = [102]
    const changedEdgeLayout = layoutSubgraph(changedEdge)
    expect(instance.requests).toHaveLength(3)
    instance.onmessage?.({
      data: { id: instance.requests[2].id, ok: true, result: bundledGeometry },
    } as MessageEvent)
    await changedEdgeLayout
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
