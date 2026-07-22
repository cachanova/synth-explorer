import {
  interpretSchemWeaveResult,
  toSchemWeaveGraph,
  type LayoutGeometry,
  type LayoutInput,
} from '../lib/layout'

export interface LayoutRequest {
  id: number
  input: LayoutInput
}

export type LayoutResponse =
  | { id: number; ok: true; result: LayoutGeometry }
  | { id: number; ok: false; error: string; kind?: 'load' }

interface LayoutModule {
  layout_json(graph: string): string
}

export function runSchemWeaveRequest(
  engine: LayoutModule,
  request: LayoutRequest,
): LayoutResponse {
  try {
    const graph = toSchemWeaveGraph(request.input)
    const result = JSON.parse(engine.layout_json(JSON.stringify(graph)))
    return {
      id: request.id,
      ok: true,
      result: interpretSchemWeaveResult(result),
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
