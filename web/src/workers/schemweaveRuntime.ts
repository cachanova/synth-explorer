import type {
  SchemWeaveExpansionRequest,
  SchemWeaveLayout,
  SchemWeaveLayoutRequest,
} from '../lib/layout'

export type SchemWeaveRequest =
  | {
      id: number
      kind?: 'layout'
      request: SchemWeaveLayoutRequest
    }
  | {
      id: number
      kind: 'expand'
      request: SchemWeaveExpansionRequest
    }

export type SchemWeaveExpansionResponse =
  | { status: 'layout'; layout: SchemWeaveLayout }
  | {
      status: 'needs_full_relayout'
      reason: 'geometry' | 'work_limit' | 'preserved_geometry_too_large'
    }

export const SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME =
  'BoundaryBundleGeometryUnsatisfied'
export const SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK =
  'boundary-bundles-omitted'

export type SchemWeaveErrorKind =
  | 'load'
  | 'boundary-bundle-geometry-unsatisfied'

export type SchemWeaveResponse =
  | {
      id: number
      ok: true
      result: SchemWeaveLayout | SchemWeaveExpansionResponse
      fallback?: typeof SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK
    }
  | { id: number; ok: false; error: string; kind?: SchemWeaveErrorKind }

interface LayoutModule {
  layout_json(graph: string): string
  expand_group_json?(request: string): string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorKind(error: unknown): SchemWeaveErrorKind | undefined {
  return error instanceof Error &&
      error.name === SCHEMWEAVE_BOUNDARY_BUNDLE_ERROR_NAME
    ? 'boundary-bundle-geometry-unsatisfied'
    : undefined
}

function runLayoutJson(
  engine: LayoutModule,
  request: SchemWeaveLayoutRequest,
): SchemWeaveLayout {
  return JSON.parse(
    engine.layout_json(JSON.stringify(request)),
  ) as SchemWeaveLayout
}

export function runSchemWeaveRequest(
  engine: LayoutModule,
  request: SchemWeaveRequest,
): SchemWeaveResponse {
  if (request.kind === 'expand') {
    try {
      if (!engine.expand_group_json) {
        throw new Error('SchemWeave expansion API is unavailable')
      }
      return {
        id: request.id,
        ok: true,
        result: JSON.parse(
          engine.expand_group_json(JSON.stringify(request.request)),
        ) as SchemWeaveExpansionResponse,
      }
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: errorMessage(error),
      }
    }
  }
  try {
    const result = runLayoutJson(engine, request.request)
    return {
      id: request.id,
      ok: true,
      result,
    }
  } catch (firstError) {
    const firstKind = errorKind(firstError)
    const bundles = request.request.constraints.boundary_bundles
    if (
      firstKind === 'boundary-bundle-geometry-unsatisfied' &&
      bundles &&
      bundles.length > 0
    ) {
      const constraints = { ...request.request.constraints }
      delete constraints.boundary_bundles
      try {
        return {
          id: request.id,
          ok: true,
          result: runLayoutJson(engine, {
            ...request.request,
            constraints,
          }),
          fallback: SCHEMWEAVE_BOUNDARY_BUNDLE_FALLBACK,
        }
      } catch (retryError) {
        const retryKind = errorKind(retryError)
        return {
          id: request.id,
          ok: false,
          error:
            `boundary bundle layout failed: ${errorMessage(firstError)}; ` +
            `bundle-free retry failed: ${errorMessage(retryError)}`,
          ...(retryKind ? { kind: retryKind } : {}),
        }
      }
    }
    return {
      id: request.id,
      ok: false,
      error: errorMessage(firstError),
      ...(firstKind ? { kind: firstKind } : {}),
    }
  }
}
