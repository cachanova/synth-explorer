import type {
  AnalysisInitialization,
  AnalysisMethod,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from '../workers/analysis.worker'
import { EngineLoadError } from './engineLoad'

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

let worker: Worker | null = null
let sequence = 0
const pending = new Map<number, Pending>()

export function initializeAnalysis<T>(payload: AnalysisInitialization): Promise<T> {
  return send<T>({ id: nextId(), kind: 'initialize', payload })
}

export function queryAnalysis<T>(method: AnalysisMethod, payload?: unknown): Promise<T> {
  return send<T>({ id: nextId(), kind: 'query', method, payload })
}

export function resetAnalysis(reason = new Error('analysis worker reset')) {
  worker?.terminate()
  worker = null
  for (const entry of pending.values()) entry.reject(reason)
  pending.clear()
}

function send<T>(request: AnalysisWorkerRequest): Promise<T> {
  const active = getWorker()
  return new Promise<T>((resolve, reject) => {
    pending.set(request.id, {
      resolve: (value) => resolve(value as T),
      reject,
    })
    active.postMessage(request)
  })
}

function getWorker(): Worker {
  if (worker) return worker
  const active = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
    type: 'module',
  })
  active.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
    const response = event.data
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    if (response.ok) entry.resolve(response.result)
    else if (response.kind === 'load') entry.reject(new EngineLoadError(response.error))
    else entry.reject(new Error(response.error))
  }
  // handle() catches everything inside the worker, so an 'error' event here
  // means the worker script itself failed to load or parse — an engine load
  // failure, not a design error.
  active.onerror = (event) =>
    resetAnalysis(new EngineLoadError(event.message || 'failed to load the analysis worker'))
  worker = active
  return active
}

function nextId(): number {
  sequence += 1
  return sequence
}
