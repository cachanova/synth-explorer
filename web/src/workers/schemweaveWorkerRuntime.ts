import {
  buildSchemWeaveCollapseRequest,
  buildSchemWeaveExpansionRequest,
  buildSchemWeaveLayoutRequest,
  interpretSchemWeaveResult,
  type ExpandedGroupLayout,
  type LayoutGeometry,
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

function failure(
  response: Extract<SchemWeaveResponse, { ok: false }>,
): SchemWeaveWorkerResponse {
  return response
}

function groupGeometry(
  geometry: LayoutGeometry,
  groups: ExpandedGroupLayout[],
): void {
  if (geometry.schemWeaveSnapshot) {
    geometry.schemWeaveSnapshot.expandedGroups = groups
  }
  geometry.groups = groups.map((group) => {
    const memberIds = new Set(group.members)
    const members = geometry.nodes.filter((node) => memberIds.has(node.id))
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
  }).sort((first, second) => first.id - second.id)
}

function layoutResult(
  request: SchemWeaveWorkerRequest,
  response: Extract<SchemWeaveResponse, { ok: true }>,
  prepared: ReturnType<typeof buildSchemWeaveLayoutRequest>,
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
): SchemWeaveWorkerResponse {
  try {
    if (request.kind === 'layout') {
      const prepared = buildSchemWeaveLayoutRequest(request.input)
      const response = runSchemWeaveRequest(engine, {
        id: request.id,
        request: prepared.request,
      })
      if (!response.ok) return failure(response)
      return layoutResult(request, response, prepared)
    }
    if (request.kind === 'expand') {
      const prepared = buildSchemWeaveExpansionRequest(
        request.snapshot,
        request.input,
        request.group,
      )
      const response = runSchemWeaveRequest(engine, {
        id: request.id,
        kind: 'expand',
        request: prepared.request,
      })
      if (!response.ok) return failure(response)
      return groupChangeResult(request, response, prepared)
    }
    const prepared = buildSchemWeaveCollapseRequest(
      request.snapshot,
      request.expandedInput,
      request.compactInput,
      request.group,
    )
    const response = runSchemWeaveRequest(engine, {
      id: request.id,
      kind: 'collapse',
      request: prepared.request,
    })
    if (!response.ok) return failure(response)
    return groupChangeResult(request, response, prepared)
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
