// Subgraph-to-ELK preparation, layered layout, and render-geometry adaptation
// run inside this Web Worker so none of that linear graph work blocks the UI.
// Uses the bundled build (algorithms inline) — the constructor's default fake
// worker runs synchronously here in this worker thread.

// MUST come before the elk import — see elkEnvShim.ts for why.
import './elkEnvShim'
import ELK from 'elkjs/lib/elk.bundled.js'
import { runElkRequest, startElkWarmup } from './elkRuntime'
export type { ElkRequest, ElkResponse } from './elkRuntime'
import type { ElkRequest } from './elkRuntime'

const elk = new ELK()

// Parse/JIT the same layered, fixed-port path used by real schematics while
// the worker is idle. A two-node graph pays almost all of ELK's one-time
// startup cost without doing design-sized speculative work.
const elkReady = startElkWarmup(elk)

self.onmessage = async (e: MessageEvent<ElkRequest>) => {
  ;(self as unknown as Worker).postMessage(await runElkRequest(elk, elkReady, e.data))
}
