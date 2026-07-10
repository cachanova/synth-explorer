// ELK layered layout running inside a Web Worker so the UI thread stays free.
// Uses the bundled build (algorithms inline) — the constructor's default fake
// worker runs synchronously here in this worker thread.

import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs/lib/elk-api'

const elk = new ELK()

export interface ElkRequest {
  id: number
  graph: ElkNode
}

export type ElkResponse =
  | { id: number; ok: true; result: ElkNode }
  | { id: number; ok: false; error: string }

self.onmessage = async (e: MessageEvent<ElkRequest>) => {
  const { id, graph } = e.data
  try {
    const result = await elk.layout(graph)
    const msg: ElkResponse = { id, ok: true, result }
    ;(self as unknown as Worker).postMessage(msg)
  } catch (err) {
    const msg: ElkResponse = { id, ok: false, error: String(err) }
    ;(self as unknown as Worker).postMessage(msg)
  }
}
