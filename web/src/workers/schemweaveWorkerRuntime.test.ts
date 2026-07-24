import { expect, it, vi } from 'vitest'
import type {
  LayoutInput,
  SchemWeaveGraph,
} from '../lib/layout'
import type { SchemWeaveWorkerResult } from './schemweaveProtocol'
import { SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME } from './schemweaveRuntime'
import { runSchemWeaveWorkerRequest } from './schemweaveWorkerRuntime'

const input: LayoutInput = {
  nodes: [
    {
      id: 1,
      baseWidth: 62,
      baseHeight: 46,
      controlHeight: 0,
      register: false,
      boundary: 'input',
    },
    {
      id: 2,
      baseWidth: 62,
      baseHeight: 46,
      controlHeight: 0,
      register: false,
      boundary: 'output',
    },
  ],
  edges: [{
    from: 1,
    to: 2,
    fromPort: 'Y',
    toPort: 'A',
    control: false,
    net: 0,
    netBits: [17],
  }],
}

it('prepares, runs, validates, and interprets a full layout in the worker', () => {
  const layout_json = vi.fn().mockReturnValue(JSON.stringify({
    nodes: [
      { id: 1, x: 0, y: 0, width: 62, height: 46 },
      { id: 2, x: 128, y: 0, width: 62, height: 46 },
    ],
    edges: [{
      id: 0,
      points: [{ x: 62, y: 23 }, { x: 128, y: 23 }],
    }],
    width: 190,
    height: 46,
  }))

  const response = runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 71, kind: 'layout', input },
  )

  expect(response).toEqual({
    id: 71,
    ok: true,
    result: {
      status: 'layout',
      degraded: false,
      geometry: expect.objectContaining({
        edges: [{
          inputIndex: 0,
          points: [{ x: 62, y: 23 }, { x: 128, y: 23 }],
          netBits: [17],
        }],
        schemWeaveSnapshot: expect.objectContaining({
          request: expect.any(Object),
          layout: expect.any(Object),
          catalog: expect.any(Object),
        }),
      }),
    },
  })
  expect(JSON.parse(layout_json.mock.calls[0][0])).toMatchObject({
    constraints: { inputs: [1], outputs: [2] },
    graph: {
      nodes: [{ id: 1 }, { id: 2 }],
      edges: [{ id: 0, net: 0 }],
    },
  })
})

it('contains adapter failures inside the worker response', () => {
  expect(runSchemWeaveWorkerRequest(
    { layout_json: vi.fn() },
    {
      id: 72,
      kind: 'layout',
      input: {
        nodes: [input.nodes[0]],
        edges: input.edges,
      },
    },
  )).toEqual({
    id: 72,
    ok: false,
    error: 'layout edge references an unknown node',
  })
})

it('contains malformed WASM geometry inside the worker response', () => {
  const layout_json = vi.fn().mockReturnValue(JSON.stringify({
    nodes: [
      { id: 1, x: 0, y: 0, width: 62, height: 46 },
      { id: 2, x: 128, y: 0, width: 62, height: 46 },
    ],
    edges: [{
      id: 0,
      points: [{ x: 62, y: 23 }, { x: 128, y: 23 }],
    }],
    boundary_bundles: [{
      id: 0,
      endpoint: { node: 1, port: 0 },
      role: 'input',
      width: 1,
      collector: {
        start: { x: 62, y: 23 },
        end: { x: 62, y: 23 },
      },
      spine: {
        start: { x: 62, y: 23 },
        end: { x: 62, y: 23 },
      },
      members: null,
    }],
    width: 190,
    height: 46,
  }))

  expect(runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 73, kind: 'layout', input },
  )).toEqual({
    id: 73,
    ok: false,
    error: 'boundary bundle 0 members must be an array',
  })
})

it('rejects geometry that attributes a bundle to an unknown edge', () => {
  const layout_json = vi.fn().mockReturnValue(JSON.stringify({
    nodes: [
      { id: 1, x: 0, y: 0, width: 62, height: 46 },
      { id: 2, x: 128, y: 0, width: 62, height: 46 },
    ],
    edges: [{
      id: 0,
      points: [{ x: 62, y: 23 }, { x: 128, y: 23 }],
    }],
    boundary_bundles: [{
      id: 0,
      endpoint: { node: 1, port: 0 },
      role: 'input',
      width: 1,
      collector: {
        start: { x: 62, y: 23 },
        end: { x: 62, y: 23 },
      },
      spine: {
        start: { x: 62, y: 23 },
        end: { x: 62, y: 23 },
      },
      members: [{
        edge: 99,
        slots: [0],
        tap: { x: 62, y: 23 },
      }],
    }],
    width: 190,
    height: 46,
  }))

  expect(runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 74, kind: 'layout', input },
  )).toEqual({
    id: 74,
    ok: false,
    error: 'boundary bundle 0 references unknown edge 99',
  })
})

it('returns validated degraded geometry for the bounded bundle-free retry', () => {
  const bundledInput: LayoutInput = {
    nodes: [
      {
        ...input.nodes[0],
        boundaryWidth: 1,
        boundaryMembers: [{ member: 10, bit: 0 }],
      },
      input.nodes[1],
    ],
    edges: [{
      ...input.edges[0],
      sourceBoundaryMembers: [{ member: 10, net_bits: [17] }],
    }],
  }
  const boundaryFailure = new Error(
    'boundary bundle geometry does not satisfy the hard readability contract',
  )
  boundaryFailure.name = SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME
  const fallback = {
    nodes: [
      { id: 1, x: 0, y: 0, width: 62, height: 46 },
      { id: 2, x: 128, y: 0, width: 62, height: 46 },
    ],
    edges: [{
      id: 0,
      points: [{ x: 62, y: 23 }, { x: 128, y: 23 }],
    }],
    width: 190,
    height: 46,
  }
  const layout_json = vi.fn()
    .mockImplementationOnce(() => {
      throw boundaryFailure
    })
    .mockReturnValueOnce(JSON.stringify(fallback))

  const response = runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 75, kind: 'layout', input: bundledInput },
  )
  expect(response).toMatchObject({
    id: 75,
    ok: true,
    result: {
      status: 'layout',
      degraded: true,
      geometry: {
        schemWeaveSnapshot: {
          request: {
            constraints: {
              boundary_bundles: [{ id: 0 }],
            },
          },
        },
      },
    },
  })
  expect(
    response.ok && response.result.status === 'layout'
      ? response.result.geometry.boundaryBundles
      : null,
  ).toBeUndefined()
  expect(layout_json).toHaveBeenCalledTimes(2)
  const retry = JSON.parse(layout_json.mock.calls[1][0])
  expect(retry.constraints).not.toHaveProperty('boundary_bundles')
})

it('prepares expansion and collapse contracts without returning to the UI thread', () => {
  const compact: LayoutInput = {
    nodes: [
      {
        id: 10,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
        boundary: 'internal',
      },
      {
        id: 3,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
        boundary: 'output',
      },
    ],
    edges: [{
      from: 10,
      to: 3,
      fromPort: 'Y',
      toPort: 'A',
      control: false,
      net: 0,
      netBits: [19],
    }],
  }
  const expanded: LayoutInput = {
    nodes: [
      {
        id: 1,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
        boundary: 'internal',
      },
      {
        id: 2,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
        boundary: 'internal',
      },
      compact.nodes[1],
    ],
    edges: [
      {
        from: 1,
        to: 2,
        fromPort: 'Y',
        toPort: 'A',
        control: false,
        net: 1,
        netBits: [18],
      },
      {
        from: 2,
        to: 3,
        fromPort: 'Y',
        toPort: 'A',
        control: false,
        net: 0,
        netBits: [19],
      },
    ],
  }
  const group = { id: 10, members: [1, 2], referenceHeight: 160 }
  const layoutFor = (graph: SchemWeaveGraph) => ({
    nodes: graph.nodes.map((node, index) => ({
      id: node.id,
      x: index * 128,
      y: index * 70,
      width: node.width,
      height: node.height,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      points: [
        { x: edge.source.node * 10, y: edge.source.port * 10 },
        { x: edge.target.node * 10, y: edge.target.port * 10 },
      ],
    })),
    width: graph.nodes.length * 128,
    height: graph.nodes.length * 70,
  })
  const layout_json = vi.fn((serialized: string) => {
    const request = JSON.parse(serialized) as { graph: SchemWeaveGraph }
    return JSON.stringify(layoutFor(request.graph))
  })
  const expand_group_json = vi.fn((serialized: string) => {
    const request = JSON.parse(serialized) as {
      expanded_graph: SchemWeaveGraph
    }
    return JSON.stringify({
      status: 'layout',
      layout: layoutFor(request.expanded_graph),
    })
  })
  const collapse_group_json = vi.fn((serialized: string) => {
    const request = JSON.parse(serialized) as {
      compact_graph: SchemWeaveGraph
    }
    return JSON.stringify({
      status: 'layout',
      layout: layoutFor(request.compact_graph),
    })
  })
  const engine = { layout_json, expand_group_json, collapse_group_json }

  const compactResponse = runSchemWeaveWorkerRequest(
    engine,
    { id: 81, kind: 'layout', input: compact },
  )
  expect(compactResponse.ok).toBe(true)
  const compactResult = compactResponse.ok
    ? compactResponse.result
    : null
  expect(compactResult?.status).toBe('layout')
  const compactGeometry = (
    compactResult as Extract<SchemWeaveWorkerResult, { status: 'layout' }>
  ).geometry
  const snapshot = compactGeometry.schemWeaveSnapshot
  expect(snapshot).toBeDefined()

  const malformedExpand = vi.fn((serialized: string) => {
    const request = JSON.parse(serialized) as {
      expanded_graph: SchemWeaveGraph
    }
    const layout = layoutFor(request.expanded_graph)
    layout.nodes = layout.nodes.filter((node) => node.id !== group.members[0])
    return JSON.stringify({
      status: 'layout',
      layout,
    })
  })
  expect(runSchemWeaveWorkerRequest(
    { ...engine, expand_group_json: malformedExpand },
    {
      id: 84,
      kind: 'expand',
      snapshot: snapshot!,
      input: expanded,
      group,
      activeGroups: [group],
    },
  )).toEqual({
    id: 84,
    ok: false,
    error: 'SchemWeave expansion omitted a grouped member',
  })

  const expansionResponse = runSchemWeaveWorkerRequest(engine, {
    id: 82,
    kind: 'expand',
    snapshot: snapshot!,
    input: expanded,
    group,
    activeGroups: [group],
  })
  expect(expansionResponse).toMatchObject({
    id: 82,
    ok: true,
    result: {
      status: 'layout',
      degraded: false,
      geometry: {
        groups: [{ id: 10 }],
        schemWeaveSnapshot: {
          expandedGroups: [group],
        },
      },
    },
  })
  expect(expand_group_json).toHaveBeenCalledOnce()
  const expandedGeometry = (
    expansionResponse as Extract<
      typeof expansionResponse,
      { ok: true }
    >
  ).result as Extract<SchemWeaveWorkerResult, { status: 'layout' }>

  const collapseResponse = runSchemWeaveWorkerRequest(engine, {
    id: 83,
    kind: 'collapse',
    snapshot: expandedGeometry.geometry.schemWeaveSnapshot!,
    expandedInput: expanded,
    compactInput: compact,
    group,
    activeGroups: [],
  })
  expect(collapseResponse).toMatchObject({
    id: 83,
    ok: true,
    result: {
      status: 'layout',
      degraded: false,
      geometry: {
        groups: [],
        schemWeaveSnapshot: {
          expandedGroups: [],
        },
      },
    },
  })
  expect(collapse_group_json).toHaveBeenCalledOnce()
})
