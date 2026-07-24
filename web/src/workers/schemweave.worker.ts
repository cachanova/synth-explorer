/// <reference lib="webworker" />

import init, {
  collapse_group_json,
  expand_group_json,
  layout_json,
} from '../wasm/layout/schemweave'
import { EngineLoadError, lazyLoad } from '../lib/engineLoad'
import {
  type SchemWeaveWorkerRequest,
  type SchemWeaveWorkerResponse,
} from './schemweaveProtocol'
import {
  createSchemWeaveWorkerSessionStore,
  runSchemWeaveWorkerRequest,
} from './schemweaveWorkerRuntime'
export type {
  SchemWeaveWorkerRequest,
  SchemWeaveWorkerResponse,
} from './schemweaveProtocol'

const ensureEngine = lazyLoad('failed to load the comparison layout engine', () => init())
const sessions = createSchemWeaveWorkerSessionStore()
void ensureEngine().catch(() => undefined)

self.onmessage = (event: MessageEvent<SchemWeaveWorkerRequest>) => {
  void handle(event.data)
}

async function handle(request: SchemWeaveWorkerRequest) {
  let response: SchemWeaveWorkerResponse
  try {
    await ensureEngine()
    response = runSchemWeaveWorkerRequest(
      { layout_json, expand_group_json, collapse_group_json },
      request,
      sessions,
    )
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
