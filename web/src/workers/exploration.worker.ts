/// <reference lib="webworker" />

import { analyzeSourceSelection, prepareExploration } from '../lib/exploration'
import type { SelectionOptions } from '../lib/exploration'
import type { ExplorationSnapshot, SourceSelectionResult } from '../types'

export type ExplorationWorkerRequest =
  | { id: number; kind: 'initialize'; designId: string }
  | {
      id: number
      kind: 'source'
      file: string
      startLine: number
      endLine: number
      options: SelectionOptions
    }

export type ExplorationWorkerResponse =
  | { id: number; ok: true; result: null | SourceSelectionResult }
  | { id: number; ok: false; error: string }

let prepared: ReturnType<typeof prepareExploration> | null = null

self.onmessage = (event: MessageEvent<ExplorationWorkerRequest>) => {
  void handleRequest(event.data)
}

async function handleRequest(request: ExplorationWorkerRequest) {
  try {
    if (request.kind === 'initialize') {
      const snapshot = await loadExploration(request.designId)
      prepared = prepareExploration(snapshot)
      respond({ id: request.id, ok: true, result: null })
      return
    }
    if (!prepared) throw new Error('exploration worker is not initialized')
    respond({
      id: request.id,
      ok: true,
      result: analyzeSourceSelection(
        prepared,
        request.file,
        request.startLine,
        request.endLine,
        request.options,
      ),
    })
  } catch (error) {
    respond({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function loadExploration(designId: string): Promise<ExplorationSnapshot> {
  const response = await fetch(`/api/design/${encodeURIComponent(designId)}/exploration`)
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = await response.json() as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // Keep the HTTP status when the error body is not JSON.
    }
    throw new Error(message)
  }
  const snapshot = await response.json() as ExplorationSnapshot
  if (snapshot.design_id !== designId) {
    throw new Error('exploration snapshot does not match the requested design')
  }
  return snapshot
}

function respond(response: ExplorationWorkerResponse) {
  self.postMessage(response)
}
