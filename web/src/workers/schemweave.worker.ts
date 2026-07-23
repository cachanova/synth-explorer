/// <reference lib="webworker" />

import init, { layout_json } from '../wasm/layout/schemweave'
import { EngineLoadError, lazyLoad } from '../lib/engineLoad'
import {
  runSchemWeaveRequest,
  type SchemWeaveRequest,
  type SchemWeaveResponse,
} from './schemweaveRuntime'
export type {
  SchemWeaveRequest,
  SchemWeaveResponse,
} from './schemweaveRuntime'

const ensureEngine = lazyLoad('failed to load the comparison layout engine', () => init())
void ensureEngine().catch(() => undefined)

self.onmessage = (event: MessageEvent<SchemWeaveRequest>) => {
  void handle(event.data)
}

async function handle(request: SchemWeaveRequest) {
  let response: SchemWeaveResponse
  try {
    await ensureEngine()
    response = runSchemWeaveRequest({ layout_json }, request)
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      kind: error instanceof EngineLoadError ? 'load' : undefined,
    }
  }
  self.postMessage(response)
}
