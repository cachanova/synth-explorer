import { expect, it, vi } from 'vitest'
import {
  MAX_INCREMENTAL_BOUNDARY_BIT_MEMBERSHIPS,
  type LayoutInput,
  type SchemWeaveGraph,
} from '../lib/layout'
import type {
  SchemWeaveWorkerResult,
} from './schemweaveProtocol'
import { SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME } from './schemweaveRuntime'
import {
  createSchemWeaveWorkerSessionStore,
  runSchemWeaveWorkerRequest,
  SCHEMWEAVE_WORKER_SESSION_MAX_BYTES,
  SCHEMWEAVE_WORKER_SESSION_MAX_ENTRIES,
} from './schemweaveWorkerRuntime'

const TEST_SESSION_EPOCH = 'test-worker'

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

  const sessions = createSchemWeaveWorkerSessionStore({
    epoch: TEST_SESSION_EPOCH,
  })
  const response = runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 71, kind: 'layout', input },
    sessions,
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
        schemWeaveSession: expect.objectContaining({
          sessionEpoch: TEST_SESSION_EPOCH,
          sessionId: 1,
        }),
      }),
    },
  })
  expect(sessions.entries.get(1)?.snapshot).toMatchObject({
    request: expect.any(Object),
    layout: expect.any(Object),
    catalog: expect.any(Object),
  })
  expect(
    response.ok && response.result.status === 'layout'
      ? response.result.geometry
      : null,
  ).not.toHaveProperty('schemWeaveSnapshot')
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

it('bounds retained sessions and requests a full relayout for an evicted handle', () => {
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
  const sessions = createSchemWeaveWorkerSessionStore({
    epoch: TEST_SESSION_EPOCH,
  })
  for (
    let id = 1;
    id <= SCHEMWEAVE_WORKER_SESSION_MAX_ENTRIES + 1;
    id++
  ) {
    expect(runSchemWeaveWorkerRequest(
      { layout_json },
      { id, kind: 'layout', input },
      sessions,
    )).toMatchObject({
      ok: true,
      result: {
        geometry: {
          schemWeaveSession: {
            sessionEpoch: TEST_SESSION_EPOCH,
            sessionId: id,
          },
        },
      },
    })
  }

  expect(sessions.entries.size).toBe(SCHEMWEAVE_WORKER_SESSION_MAX_ENTRIES)
  expect(sessions.entries.has(1)).toBe(false)
  expect(sessions.retainedBytes).toBeGreaterThan(0)
  expect(sessions.retainedBytes).toBeLessThanOrEqual(
    SCHEMWEAVE_WORKER_SESSION_MAX_BYTES,
  )
  expect(runSchemWeaveWorkerRequest(
    {
      layout_json,
      expand_group_json: vi.fn(() => {
        throw new Error('an evicted session must not reach WASM')
      }),
    },
    {
      id: 99,
      kind: 'expand',
      session: {
        sessionEpoch: TEST_SESSION_EPOCH,
        sessionId: 1,
      },
      input,
      group: { id: 1, members: [1] },
      activeGroups: [{ id: 1, members: [1] }],
    },
    sessions,
  )).toEqual({
    id: 99,
    ok: true,
    result: {
      status: 'needs_full_relayout',
      reason: 'geometry',
    },
  })
})

it('enforces aggregate and single-session byte budgets below the entry cap', () => {
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
  const probe = createSchemWeaveWorkerSessionStore({ epoch: 'probe' })
  runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 1, kind: 'layout', input },
    probe,
  )
  const entryBytes = probe.entries.get(1)?.retainedBytes
  expect(entryBytes).toBeGreaterThan(0)

  const aggregate = createSchemWeaveWorkerSessionStore({
    epoch: 'aggregate',
    maxEntries: SCHEMWEAVE_WORKER_SESSION_MAX_ENTRIES,
    maxBytes: entryBytes! * 2 - 1,
  })
  for (const id of [1, 2]) {
    runSchemWeaveWorkerRequest(
      { layout_json },
      { id, kind: 'layout', input },
      aggregate,
    )
  }
  expect(aggregate.entries.size).toBe(1)
  expect(aggregate.entries.has(1)).toBe(false)
  expect(aggregate.entries.has(2)).toBe(true)
  expect(aggregate.retainedBytes).toBe(entryBytes)

  const oversized = createSchemWeaveWorkerSessionStore({
    epoch: 'oversized',
    maxEntries: SCHEMWEAVE_WORKER_SESSION_MAX_ENTRIES,
    maxBytes: entryBytes! - 1,
  })
  const response = runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 3, kind: 'layout', input },
    oversized,
  )
  expect(response).toMatchObject({
    ok: true,
    result: { status: 'layout' },
  })
  expect(
    response.ok && response.result.status === 'layout'
      ? response.result.geometry
      : null,
  ).not.toHaveProperty('schemWeaveSession')
  expect(oversized.entries.size).toBe(0)
  expect(oversized.retainedBytes).toBe(0)

  const stringBudget = createSchemWeaveWorkerSessionStore({
    epoch: 'string-budget',
    maxEntries: SCHEMWEAVE_WORKER_SESSION_MAX_ENTRIES,
    maxBytes: entryBytes! + 1_000,
  })
  const longString = 'net'.repeat(1_400)
  const stringHeavyInput: LayoutInput = {
    ...input,
    edges: [{
      ...input.edges[0],
      fromPort: longString,
      toPort: longString,
      netKey: longString,
    }],
  }
  const stringResponse = runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 4, kind: 'layout', input: stringHeavyInput },
    stringBudget,
  )
  expect(stringResponse).toMatchObject({
    ok: true,
    result: { status: 'layout' },
  })
  expect(
    stringResponse.ok && stringResponse.result.status === 'layout'
      ? stringResponse.result.geometry
      : null,
  ).not.toHaveProperty('schemWeaveSession')
  expect(stringBudget.entries.size).toBe(0)
  expect(stringBudget.retainedBytes).toBe(0)
})

it('rejects a colliding numeric session id from a prior worker epoch', () => {
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
  const firstWorker = createSchemWeaveWorkerSessionStore({
    epoch: 'worker-a',
  })
  const firstResponse = runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 1, kind: 'layout', input },
    firstWorker,
  )
  const firstHandle =
    firstResponse.ok && firstResponse.result.status === 'layout'
      ? firstResponse.result.geometry.schemWeaveSession
      : undefined
  expect(firstHandle).toEqual({
    sessionEpoch: 'worker-a',
    sessionId: 1,
    expandedGroups: [],
  })

  const replacementWorker = createSchemWeaveWorkerSessionStore({
    epoch: 'worker-b',
  })
  runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 2, kind: 'layout', input },
    replacementWorker,
  )
  expect(replacementWorker.entries.has(1)).toBe(true)
  expect(runSchemWeaveWorkerRequest(
    {
      layout_json,
      expand_group_json: vi.fn(() => {
        throw new Error('an old epoch must not reach WASM')
      }),
    },
    {
      id: 3,
      kind: 'expand',
      session: firstHandle!,
      input,
      group: { id: 1, members: [1] },
      activeGroups: [{ id: 1, members: [1] }],
    },
    replacementWorker,
  )).toEqual({
    id: 3,
    ok: true,
    result: {
      status: 'needs_full_relayout',
      reason: 'geometry',
    },
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

  const sessions = createSchemWeaveWorkerSessionStore({
    epoch: TEST_SESSION_EPOCH,
  })
  const response = runSchemWeaveWorkerRequest(
    { layout_json },
    { id: 75, kind: 'layout', input: bundledInput },
    sessions,
  )
  expect(response).toMatchObject({
    id: 75,
    ok: true,
    result: {
      status: 'layout',
      degraded: true,
      geometry: {
        schemWeaveSession: {
          sessionEpoch: TEST_SESSION_EPOCH,
          sessionId: 1,
        },
      },
    },
  })
  expect(sessions.entries.get(1)?.snapshot.request.constraints).toMatchObject({
    boundary_bundles: [{ id: 0 }],
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

it('prepares group changes, preserves peers, and promotes the base session in LRU order', () => {
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
  const peer = { id: 20, members: [3], referenceHeight: 70 }
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
  const sessions = createSchemWeaveWorkerSessionStore({
    epoch: TEST_SESSION_EPOCH,
    maxEntries: 2,
  })

  const compactResponse = runSchemWeaveWorkerRequest(
    engine,
    { id: 81, kind: 'layout', input: compact },
    sessions,
  )
  expect(compactResponse.ok).toBe(true)
  const compactResult = compactResponse.ok
    ? compactResponse.result
    : null
  expect(compactResult?.status).toBe('layout')
  const compactGeometry = (
    compactResult as Extract<SchemWeaveWorkerResult, { status: 'layout' }>
  ).geometry
  const snapshot = compactGeometry.schemWeaveSession
  expect(snapshot).toEqual({
    sessionEpoch: TEST_SESSION_EPOCH,
    sessionId: 1,
    expandedGroups: [],
  })
  if (!snapshot) {
    throw new Error('compact layout omitted its worker session')
  }

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
      session: snapshot,
      input: expanded,
      group,
      activeGroups: [group],
    },
    sessions,
  )).toEqual({
    id: 84,
    ok: false,
    error: 'SchemWeave expansion omitted a grouped member',
  })

  expect(runSchemWeaveWorkerRequest(
    engine,
    { id: 85, kind: 'layout', input: compact },
    sessions,
  )).toMatchObject({
    ok: true,
    result: {
      geometry: {
        schemWeaveSession: {
          sessionEpoch: TEST_SESSION_EPOCH,
          sessionId: 2,
        },
      },
    },
  })

  const expansionResponse = runSchemWeaveWorkerRequest(
    engine,
    {
      id: 82,
      kind: 'expand',
      session: snapshot,
      input: expanded,
      group,
      activeGroups: [peer, group],
    },
    sessions,
  )
  expect(expansionResponse).toMatchObject({
    id: 82,
    ok: true,
    result: {
      status: 'layout',
      degraded: false,
      geometry: {
        groups: [{ id: 10 }, { id: 20 }],
        schemWeaveSession: {
          sessionEpoch: TEST_SESSION_EPOCH,
          sessionId: 3,
          expandedGroups: [group, peer],
        },
      },
    },
  })
  expect(sessions.entries.has(1)).toBe(true)
  expect(sessions.entries.has(2)).toBe(false)
  expect(sessions.entries.has(3)).toBe(true)
  expect(expand_group_json).toHaveBeenCalledOnce()
  expect(
    JSON.parse(expand_group_json.mock.calls[0][0]).protected_groups,
  ).toEqual([
    { id: 20, members: [3], frame_padding: 30 },
  ])
  const expandedGeometry = (
    expansionResponse as Extract<
      typeof expansionResponse,
      { ok: true }
    >
  ).result as Extract<SchemWeaveWorkerResult, { status: 'layout' }>

  const expandedSnapshot = expandedGeometry.geometry.schemWeaveSession
  if (!expandedSnapshot) {
    throw new Error('expanded layout omitted its worker session')
  }
  const collapseResponse = runSchemWeaveWorkerRequest(
    engine,
    {
      id: 83,
      kind: 'collapse',
      session: expandedSnapshot,
      compactInput: compact,
      group,
      activeGroups: [peer],
    },
    sessions,
  )
  expect(collapseResponse).toMatchObject({
    id: 83,
    ok: true,
    result: {
      status: 'layout',
      degraded: false,
      geometry: {
        groups: [{ id: 20 }],
        schemWeaveSession: {
          sessionEpoch: TEST_SESSION_EPOCH,
          sessionId: 4,
          expandedGroups: [peer],
        },
      },
    },
  })
  expect(collapse_group_json).toHaveBeenCalledOnce()
})

it('falls back to a full layout when incremental boundary metadata exceeds its budget', () => {
  const compact: LayoutInput = {
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
        id: 100,
        baseWidth: 62,
        baseHeight: 46,
        controlHeight: 0,
        register: false,
        boundary: 'internal',
      },
    ],
    edges: [{
      from: 1,
      to: 100,
      fromPort: 'Y',
      toPort: 'D',
      control: false,
      netBits: [1],
      netKey: 'compact',
    }],
  }
  const expanded: LayoutInput = {
    nodes: [compact.nodes[0], { ...compact.nodes[1], id: 10 }],
    edges: [{
      ...compact.edges[0],
      to: 10,
      netKey: 'expanded',
    }],
  }
  const layoutFor = (graph: SchemWeaveGraph) => ({
    nodes: graph.nodes.map((node, index) => ({
      id: node.id,
      x: index * 100,
      y: 0,
      width: node.width,
      height: node.height,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      points: [],
    })),
    width: graph.nodes.length * 100,
    height: 50,
  })
  const layout_json = vi.fn((serialized: string) => {
    const request = JSON.parse(serialized) as { graph: SchemWeaveGraph }
    return JSON.stringify(layoutFor(request.graph))
  })
  const expand_group_json = vi.fn()
  const sessions = createSchemWeaveWorkerSessionStore({
    epoch: TEST_SESSION_EPOCH,
  })
  const compactResponse = runSchemWeaveWorkerRequest(
    { layout_json, expand_group_json },
    { id: 90, kind: 'layout', input: compact },
    sessions,
  )
  if (
    !compactResponse.ok ||
    compactResponse.result.status !== 'layout' ||
    !compactResponse.result.geometry.schemWeaveSession
  ) {
    throw new Error('compact layout omitted its worker session')
  }
  const handle = compactResponse.result.geometry.schemWeaveSession
  const retained = sessions.entries.get(handle.sessionId)
  if (!retained) throw new Error('compact worker session was not retained')
  retained.snapshot.catalog.fragments[0].netBits = Array.from(
    { length: MAX_INCREMENTAL_BOUNDARY_BIT_MEMBERSHIPS + 1 },
    (_, bit) => bit,
  )

  expect(runSchemWeaveWorkerRequest(
    { layout_json, expand_group_json },
    {
      id: 91,
      kind: 'expand',
      session: handle,
      input: expanded,
      group: { id: 100, members: [10] },
      activeGroups: [{ id: 100, members: [10] }],
    },
    sessions,
  )).toEqual({
    id: 91,
    ok: true,
    result: {
      status: 'needs_full_relayout',
      reason: 'work_limit',
    },
  })
  expect(expand_group_json).not.toHaveBeenCalled()
})
