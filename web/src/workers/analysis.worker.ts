/// <reference lib="webworker" />

import init, { AnalysisSession } from '../wasm/analysis/analysis'
import { EngineLoadError, lazyLoad } from '../lib/engineLoad'

export interface AnalysisInitialization {
  designId: string
  netlistJson: string
  sourceNetlistJson: string
  filesJson: string
  mode: string
  tool: string
  profile: string
}

export type AnalysisMethod =
  | 'endpoints'
  | 'timing'
  | 'paths'
  | 'cone'
  | 'netlist'
  | 'expandGroup'
  | 'fanout'
  | 'sourceMap'
  | 'sourceBits'
  | 'nodes'
  | 'source'

export type AnalysisWorkerRequest =
  | { id: number; kind: 'initialize'; payload: AnalysisInitialization }
  | { id: number; kind: 'query'; method: AnalysisMethod; payload?: unknown }

export type AnalysisWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string; kind?: 'load' }

let session: AnalysisSession | null = null
const ensureEngine = lazyLoad('failed to load the analysis engine', () => init())

self.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  void handle(event.data)
}

async function handle(request: AnalysisWorkerRequest) {
  try {
    await ensureEngine()
    if (request.kind === 'initialize') {
      session?.free()
      const payload = request.payload
      session = new AnalysisSession(
        payload.designId,
        payload.netlistJson,
        payload.sourceNetlistJson,
        payload.filesJson,
        payload.mode,
        payload.tool,
        payload.profile,
      )
      respond({ id: request.id, ok: true, result: parse(session.summary_json()) })
      return
    }
    if (!session) throw new Error('analysis worker is not initialized')
    respond({ id: request.id, ok: true, result: query(session, request.method, request.payload) })
  } catch (error) {
    respond({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      kind: error instanceof EngineLoadError ? 'load' : undefined,
    })
  }
}

function query(active: AnalysisSession, method: AnalysisMethod, payload?: unknown): unknown {
  switch (method) {
    case 'endpoints':
      return parse(active.endpoints_json())
    case 'timing':
      return parse(active.timing_json(JSON.stringify(payload ?? {})))
    case 'paths':
      return parse(active.paths_json(JSON.stringify(payload ?? {})))
    case 'cone':
      return parse(active.cone_json(JSON.stringify(payload ?? {})))
    case 'netlist':
      return parse(active.netlist_json(JSON.stringify(payload ?? {})))
    case 'expandGroup':
      return parse(active.expand_group_json(JSON.stringify(payload ?? {})))
    case 'fanout':
      return parse(active.fanout_json(typeof payload === 'number' ? payload : undefined))
    case 'sourceMap':
      return parse(active.source_map_json())
    case 'sourceBits':
      return parse(active.source_ranges_for_bits_json(JSON.stringify(payload ?? [])))
    case 'nodes':
      return parse(active.nodes_json(JSON.stringify(payload ?? [])))
    case 'source':
      return parse(active.source_selection_json(JSON.stringify(payload ?? {})))
  }
}

function parse(json: string): unknown {
  return JSON.parse(json)
}

function respond(response: AnalysisWorkerResponse) {
  self.postMessage(response)
}
