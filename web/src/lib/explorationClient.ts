import type { SourceSelectionResult } from '../types'
import type { SelectionOptions } from './exploration'
import type {
  ExplorationWorkerRequest,
  ExplorationWorkerResponse,
} from '../workers/exploration.worker'

interface Pending {
  resolve(value: SourceSelectionResult | null): void
  reject(error: Error): void
}

let worker: Worker | null = null
let designId: string | null = null
let initialization: Promise<void> | null = null
let sequence = 0
const pending = new Map<number, Pending>()

export function initializeExploration(id: string): Promise<void> {
  if (designId === id && initialization) return initialization
  resetWorker()
  designId = id
  const instance = getWorker()
  initialization = send(instance, { id: nextId(), kind: 'initialize', designId: id })
    .then(() => undefined)
    .catch((error) => {
      if (designId === id) resetExploration()
      throw error
    })
  return initialization
}

export async function analyzeSourceInBrowser(
  id: string,
  selection: { file: string; startLine: number; endLine: number },
  options: SelectionOptions,
  signal?: AbortSignal,
): Promise<SourceSelectionResult> {
  await abortable(initializeExploration(id), signal)
  if (designId !== id) throw abortError()
  const result = await abortable(
    send(getWorker(), {
      id: nextId(),
      kind: 'source',
      file: selection.file,
      startLine: selection.startLine,
      endLine: selection.endLine,
      options,
    }),
    signal,
  )
  if (!result) throw new Error('exploration worker returned no selection result')
  return result
}

export function resetExploration(reason?: Error) {
  designId = null
  initialization = null
  resetWorker(reason)
}

function getWorker(): Worker {
  if (worker) return worker
  const instance = new Worker(new URL('../workers/exploration.worker.ts', import.meta.url), {
    type: 'module',
  })
  instance.onmessage = (event: MessageEvent<ExplorationWorkerResponse>) => {
    const response = event.data
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    if (response.ok) entry.resolve(response.result)
    else entry.reject(new Error(response.error))
  }
  instance.onerror = (event) => {
    resetExploration(new Error(event.message || 'exploration worker error'))
  }
  worker = instance
  return instance
}

function send(
  instance: Worker,
  request: ExplorationWorkerRequest,
): Promise<SourceSelectionResult | null> {
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject })
    instance.postMessage(request)
  })
}

function nextId(): number {
  sequence += 1
  return sequence
}

function resetWorker(reason = new Error('exploration worker reset')) {
  worker?.terminate()
  worker = null
  for (const entry of pending.values()) entry.reject(reason)
  pending.clear()
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}
