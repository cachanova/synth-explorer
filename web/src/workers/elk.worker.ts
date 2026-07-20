// Subgraph-to-ELK preparation, layered layout, and render-geometry adaptation
// run inside this Web Worker so none of that linear graph work blocks the UI.
// Uses the bundled build (algorithms inline) — the constructor's default fake
// worker runs synchronously here in this worker thread.

// MUST come before the elk import — see elkEnvShim.ts for why.
import './elkEnvShim'
import ELK from 'elkjs/lib/elk.bundled.js'
import {
  interpretResult,
  toElkGraph,
  type LayoutGeometry,
  type LayoutInput,
  type NodePlacement,
} from '../lib/layout'

const elk = new ELK()

export interface ElkRequest {
  id: number
  input: LayoutInput
  placement: NodePlacement
}

export type ElkResponse =
  | { id: number; ok: true; result: LayoutGeometry }
  | { id: number; ok: false; error: string }

self.onmessage = async (e: MessageEvent<ElkRequest>) => {
  const { id, input, placement } = e.data
  try {
    const graph = toElkGraph(input, placement)
    const laidOut = await elk.layout(graph)
    const result = interpretResult(input, laidOut)
    const msg: ElkResponse = { id, ok: true, result }
    ;(self as unknown as Worker).postMessage(msg)
  } catch (err) {
    const msg: ElkResponse = { id, ok: false, error: String(err) }
    ;(self as unknown as Worker).postMessage(msg)
  }
}
