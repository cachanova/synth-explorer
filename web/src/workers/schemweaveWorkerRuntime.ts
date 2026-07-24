import {
  buildSchemWeaveCollapseRequest,
  buildSchemWeaveExpansionRequest,
  buildSchemWeaveLayoutRequest,
  interpretSchemWeaveResult,
  SCHEMWEAVE_INCREMENTAL_WORK_LIMIT_ERROR_NAME,
  type ExpandedGroupLayout,
  type LayoutGeometry,
  type LayoutInput,
  type SchemWeaveSessionHandle,
  type SchemWeaveSnapshot,
} from '../lib/layout'
import {
  SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
  runSchemWeaveRequest,
  type SchemWeaveEngine,
  type SchemWeaveExpansionResponse,
  type SchemWeaveResponse,
} from './schemweaveRuntime'
import type {
  SchemWeaveWorkerRequest,
  SchemWeaveWorkerResponse,
} from './schemweaveProtocol'

export const SCHEMWEAVE_WORKER_SESSION_MAX_ENTRIES = 8
export const SCHEMWEAVE_WORKER_SESSION_MAX_BYTES = 32 * 1024 * 1024

export interface SchemWeaveWorkerSession {
  snapshot: SchemWeaveSnapshot
  input: LayoutInput
  retainedBytes: number
}

export interface SchemWeaveWorkerSessionStore {
  epoch: string
  nextId: number
  entries: Map<number, SchemWeaveWorkerSession>
  retainedBytes: number
  maxEntries: number
  maxBytes: number
}

export function createSchemWeaveWorkerSessionStore(
  options: {
    epoch?: string
    maxEntries?: number
    maxBytes?: number
  } = {},
):
  SchemWeaveWorkerSessionStore {
  return {
    epoch: options.epoch ?? globalThis.crypto.randomUUID(),
    nextId: 0,
    entries: new Map(),
    retainedBytes: 0,
    maxEntries:
      options.maxEntries ?? SCHEMWEAVE_WORKER_SESSION_MAX_ENTRIES,
    maxBytes: options.maxBytes ?? SCHEMWEAVE_WORKER_SESSION_MAX_BYTES,
  }
}

function estimatedSessionBytes(
  snapshot: SchemWeaveSnapshot,
  input: LayoutInput,
): number {
  const graphPortCount = snapshot.request.graph.nodes.reduce(
    (total, node) => total + node.ports.length,
    0,
  )
  const layoutPointCount = snapshot.layout.edges.reduce(
    (total, edge) => total + edge.points.length,
    0,
  )
  const fragmentBitCount = snapshot.catalog.fragments.reduce(
    (total, fragment) =>
      total +
      (fragment.netBits?.length ?? 0) +
      (fragment.sourceBundle?.slots.length ?? 0) +
      (fragment.targetBundle?.slots.length ?? 0),
    0,
  )
  const inputBitCount = input.edges.reduce(
    (total, edge) =>
      total +
      (edge.netBits?.length ?? 0) +
      (edge.sourceBoundaryMembers?.reduce(
        (count, member) => count + member.net_bits.length,
        0,
      ) ?? 0) +
      (edge.targetBoundaryMembers?.reduce(
        (count, member) => count + member.net_bits.length,
        0,
      ) ?? 0),
    0,
  )
  const retainedStringBytes =
    [...snapshot.catalog.portIds.keys()].reduce(
      (total, key) => total + key.length * 2,
      0,
    ) +
    snapshot.catalog.fragments.reduce(
      (total, fragment) => total + fragment.netKey.length * 2,
      0,
    ) +
    input.edges.reduce(
      (total, edge) =>
        total +
        edge.fromPort.length * 2 +
        edge.toPort.length * 2 +
        (edge.netKey?.length ?? 0) * 2,
      0,
    )
  return (
    snapshot.request.graph.nodes.length * 160 +
    graphPortCount * 48 +
    snapshot.request.graph.edges.length * 128 +
    snapshot.layout.nodes.length * 64 +
    snapshot.layout.edges.length * 96 +
    layoutPointCount * 32 +
    snapshot.catalog.portIds.size * 80 +
    snapshot.catalog.fragments.length * 112 +
    fragmentBitCount * 8 +
    input.nodes.length * 96 +
    input.edges.length * 128 +
    inputBitCount * 8 +
    retainedStringBytes +
    (input.groups?.reduce(
      (total, group) => total + 64 + group.members.length * 8,
      0,
    ) ?? 0) +
    512
  )
}

function session(
  store: SchemWeaveWorkerSessionStore,
  handle: SchemWeaveSessionHandle,
): SchemWeaveWorkerSession | null {
  if (handle.sessionEpoch !== store.epoch) return null
  const entry = store.entries.get(handle.sessionId)
  if (!entry) return null
  store.entries.delete(handle.sessionId)
  store.entries.set(handle.sessionId, entry)
  return entry
}

function retainSession(
  store: SchemWeaveWorkerSessionStore,
  geometry: LayoutGeometry,
  input: LayoutInput,
): void {
  const snapshot = geometry.schemWeaveSnapshot
  if (!snapshot) {
    throw new Error('SchemWeave geometry omitted its worker snapshot')
  }
  const retainedBytes = estimatedSessionBytes(snapshot, input)
  if (retainedBytes > store.maxBytes) {
    delete geometry.schemWeaveSnapshot
    return
  }
  const sessionId = ++store.nextId
  store.entries.set(sessionId, { snapshot, input, retainedBytes })
  store.retainedBytes += retainedBytes
  while (
    store.entries.size > store.maxEntries ||
    store.retainedBytes > store.maxBytes
  ) {
    const oldestId = store.entries.keys().next().value
    if (oldestId == null) break
    const oldest = store.entries.get(oldestId)
    store.entries.delete(oldestId)
    store.retainedBytes -= oldest?.retainedBytes ?? 0
  }
  const handle: SchemWeaveSessionHandle = {
    sessionEpoch: store.epoch,
    sessionId,
    ...(snapshot.expandedGroups
      ? { expandedGroups: snapshot.expandedGroups }
      : {}),
  }
  delete geometry.schemWeaveSnapshot
  geometry.schemWeaveSession = handle
}

function missingSession(
  id: number,
): SchemWeaveWorkerResponse {
  return {
    id,
    ok: true,
    result: {
      status: 'needs_full_relayout',
      reason: 'geometry',
    },
  }
}

function failure(
  response: Extract<SchemWeaveResponse, { ok: false }>,
): SchemWeaveWorkerResponse {
  return response
}

function groupGeometry(
  geometry: LayoutGeometry,
  groups: ExpandedGroupLayout[],
): void {
  const activeGroups = [...groups].sort(
    (first, second) => first.id - second.id,
  )
  const nodeById = new Map(geometry.nodes.map((node) => [node.id, node]))
  if (geometry.schemWeaveSnapshot) {
    geometry.schemWeaveSnapshot.expandedGroups = activeGroups
  }
  geometry.groups = activeGroups.map((group) => {
    const memberIds = new Set(group.members)
    const members = [...memberIds].flatMap((id) => {
      const member = nodeById.get(id)
      return member ? [member] : []
    })
    if (members.length !== memberIds.size) {
      throw new Error('SchemWeave expansion omitted a grouped member')
    }
    const left = Math.min(...members.map((node) => node.x))
    const top = Math.min(...members.map((node) => node.y))
    const right = Math.max(...members.map((node) => node.x + node.width))
    const bottom = Math.max(...members.map((node) => node.y + node.height))
    return {
      id: group.id,
      x: left - 16,
      y: top - 30,
      width: right - left + 32,
      height: bottom - top + 46,
    }
  })
}

function layoutResult(
  request: SchemWeaveWorkerRequest,
  response: Extract<SchemWeaveResponse, { ok: true }>,
  prepared: ReturnType<typeof buildSchemWeaveLayoutRequest>,
  sessions: SchemWeaveWorkerSessionStore,
): SchemWeaveWorkerResponse {
  if (request.kind !== 'layout') {
    throw new Error('full-layout response used for a group change')
  }
  const rawFallback = response.fallback
  if (
    rawFallback !== undefined &&
    rawFallback !== SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK
  ) {
    throw new Error('invalid SchemWeave fallback marker')
  }
  const allowsFallback =
    (prepared.request.constraints.boundary_bundles?.length ?? 0) > 0
  if (
    rawFallback === SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK &&
    !allowsFallback
  ) {
    throw new Error(
      'SchemWeave fallback marker requires boundary bundle constraints',
    )
  }
  const geometry = interpretSchemWeaveResult(
    response.result as Parameters<typeof interpretSchemWeaveResult>[0],
    prepared.catalog,
    prepared.request,
  )
  if (
    rawFallback === SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK &&
    (geometry.boundaryBundles?.length ?? 0) > 0
  ) {
    throw new Error(
      'SchemWeave fallback geometry cannot contain boundary bundles',
    )
  }
  groupGeometry(geometry, request.input.groups ?? [])
  retainSession(sessions, geometry, request.input)
  return {
    id: request.id,
    ok: true,
    result: {
      status: 'layout',
      geometry,
      degraded:
        rawFallback === SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
    },
  }
}

function groupChangeResult(
  request: Exclude<SchemWeaveWorkerRequest, { kind: 'layout' }>,
  response: Extract<SchemWeaveResponse, { ok: true }>,
  prepared: ReturnType<
    typeof buildSchemWeaveExpansionRequest |
    typeof buildSchemWeaveCollapseRequest
  >,
  input: LayoutInput,
  sessions: SchemWeaveWorkerSessionStore,
): SchemWeaveWorkerResponse {
  const result = response.result as SchemWeaveExpansionResponse
  if (result.status === 'needs_full_relayout') {
    return { id: request.id, ok: true, result }
  }
  if (result.status !== 'layout') {
    throw new Error('invalid SchemWeave group-change response')
  }
  const layoutRequest = request.kind === 'expand'
    ? (prepared as ReturnType<typeof buildSchemWeaveExpansionRequest>)
      .expandedRequest
    : (prepared as ReturnType<typeof buildSchemWeaveCollapseRequest>)
      .compactRequest
  const geometry = interpretSchemWeaveResult(
    result.layout,
    prepared.catalog,
    layoutRequest,
  )
  groupGeometry(geometry, request.activeGroups)
  retainSession(sessions, geometry, input)
  return {
    id: request.id,
    ok: true,
    result: { status: 'layout', geometry, degraded: false },
  }
}

/**
 * Own the complete SchemWeave adapter pipeline inside the worker: graph
 * construction, incremental contract reconciliation, WASM, and validation.
 */
export function runSchemWeaveWorkerRequest(
  engine: SchemWeaveEngine,
  request: SchemWeaveWorkerRequest,
  sessions = createSchemWeaveWorkerSessionStore(),
): SchemWeaveWorkerResponse {
  try {
    if (request.kind === 'layout') {
      const prepared = buildSchemWeaveLayoutRequest(request.input)
      const response = runSchemWeaveRequest(engine, {
        id: request.id,
        request: prepared.request,
      })
      if (!response.ok) return failure(response)
      return layoutResult(request, response, prepared, sessions)
    }
    if (request.kind === 'expand') {
      const base = session(sessions, request.session)
      if (!base) return missingSession(request.id)
      const prepared = buildSchemWeaveExpansionRequest(
        base.snapshot,
        request.input,
        request.group,
        request.activeGroups,
      )
      const response = runSchemWeaveRequest(engine, {
        id: request.id,
        kind: 'expand',
        request: prepared.request,
      })
      if (!response.ok) return failure(response)
      return groupChangeResult(
        request,
        response,
        prepared,
        request.input,
        sessions,
      )
    }
    const base = session(sessions, request.session)
    if (!base) return missingSession(request.id)
    const prepared = buildSchemWeaveCollapseRequest(
      base.snapshot,
      base.input,
      request.compactInput,
      request.group,
    )
    const response = runSchemWeaveRequest(engine, {
      id: request.id,
      kind: 'collapse',
      request: prepared.request,
    })
    if (!response.ok) return failure(response)
    return groupChangeResult(
      request,
      response,
      prepared,
      request.compactInput,
      sessions,
    )
  } catch (error) {
    if (
      request.kind !== 'layout' &&
      error instanceof Error &&
      error.name === SCHEMWEAVE_INCREMENTAL_WORK_LIMIT_ERROR_NAME
    ) {
      return {
        id: request.id,
        ok: true,
        result: {
          status: 'needs_full_relayout',
          reason: 'work_limit',
        },
      }
    }
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
