/// <reference lib="webworker" />

import init, { layout_json } from '../wasm/layout/schemweave'
import { EngineLoadError, lazyLoad } from '../lib/engineLoad'
import {
  runSchemWeaveRequest,
  type LayoutRequest,
  type LayoutResponse,
} from './schemweaveRuntime'
export type { LayoutRequest, LayoutResponse } from './schemweaveRuntime'

const ensureEngine = lazyLoad('failed to load the layout engine', () => init())
// Worker construction is the prewarm signal. Fetch and compile WASM while the
// editor is idle; lazyLoad drops failures so the first real request can retry.
void ensureEngine().catch(() => undefined)

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  void handle(event.data)
}

async function handle(request: LayoutRequest) {
  let response: LayoutResponse
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
