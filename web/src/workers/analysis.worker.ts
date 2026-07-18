/// <reference lib="webworker" />

import init, { AnalysisSession } from '../wasm/analysis/analysis'

export interface AnalysisInitialization {
  designId: string
  netlistJson: string
  sourceNetlistJson: string
  filesJson: string
  mode: string
  profile: string
}

export type AnalysisMethod =
  | 'endpoints'
  | 'timing'
  | 'paths'
  | 'cone'
  | 'netlist'
  | 'fanout'
  | 'sourceMap'
  | 'nodes'
  | 'exploration'

export type AnalysisWorkerRequest =
  | { id: number; kind: 'initialize'; payload: AnalysisInitialization }
  | { id: number; kind: 'query'; method: AnalysisMethod; payload?: unknown }

export type AnalysisWorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }

let session: AnalysisSession | null = null
// Never cache a failed engine load: a transient network drop while fetching
// the WASM module would otherwise reject every later request in this worker,
// so a failure clears the cache and the next request retries the load.
let initialized: Promise<unknown> | null = null

function ensureEngine(): Promise<unknown> {
  initialized ??= init().catch((error: unknown) => {
    initialized = null
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to load the analysis engine: ${detail}`)
  })
  return initialized
}

// Warm the engine as soon as the worker starts; failures surface on first use.
void ensureEngine().catch(() => {})

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
    case 'fanout':
      return parse(active.fanout_json(typeof payload === 'number' ? payload : undefined))
    case 'sourceMap':
      return parse(active.source_map_json())
    case 'nodes':
      return parse(active.nodes_json(JSON.stringify(payload ?? [])))
    case 'exploration':
      return parse(active.exploration_json())
  }
}

function parse(json: string): unknown {
  return JSON.parse(json)
}

function respond(response: AnalysisWorkerResponse) {
  self.postMessage(response)
}
