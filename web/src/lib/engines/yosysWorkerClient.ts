import type { YosysWorkerResult } from '../../workers/yosys.worker'
import type { MemoryHandling, ValidatedSynthesis } from '../yosysScript'
import { LocalSynthesisError, abortError } from '../synthesisError'

interface YosysWorkerResponse {
  ok: boolean
  result?: YosysWorkerResult
  error?: string
  kind?: 'load'
  log?: string
}

let idleYosysWorker: Worker | null = null

export function runYosys(
  input: ValidatedSynthesis,
  memory: MemoryHandling,
  signal?: AbortSignal,
): Promise<YosysWorkerResult> {
  return runYosysWorker({ input, memory }, signal)
}

export function runVivadoNormalizer(
  netlist: string,
  top: string,
  sourceNetlistJson: string,
  signal?: AbortSignal,
): Promise<YosysWorkerResult> {
  return runYosysWorker(
    { kind: 'vivado-normalize', netlist, top, sourceNetlistJson },
    signal,
  )
}

type YosysWorkerRequest =
  | { input: ValidatedSynthesis; memory: MemoryHandling }
  | { kind: 'vivado-normalize'; netlist: string; top: string; sourceNetlistJson: string }

function runYosysWorker(
  request: YosysWorkerRequest,
  signal?: AbortSignal,
): Promise<YosysWorkerResult> {
  const worker = acquireYosysWorker()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (action: () => void, reusable: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (reusable) releaseYosysWorker(worker)
      else discardYosysWorker(worker)
      action()
    }
    const onAbort = () => finish(() => reject(abortError()), false)
    const timeout = setTimeout(() => {
      finish(() => reject(new LocalSynthesisError('yosys timed out', '', 'timeout')), false)
    }, 60_000)
    worker.onmessage = (event: MessageEvent<YosysWorkerResponse>) => {
      const response = event.data
      finish(() => {
        if (response.ok && response.result) resolve(response.result)
        else {
          reject(
            new LocalSynthesisError(response.error ?? 'yosys failed', response.log ?? '', response.kind),
          )
        }
      }, true)
    }
    // run() catches everything inside the worker, so an 'error' event here
    // means the worker script itself failed to load or parse.
    worker.onerror = (event) => {
      finish(
        () =>
          reject(
            new LocalSynthesisError(event.message || 'failed to load the Yosys worker', '', 'load'),
          ),
        false,
      )
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      worker.postMessage(request)
    } catch (error) {
      finish(() => reject(error), false)
    }
  })
}

function createYosysWorker(): Worker {
  return new Worker(new URL('../../workers/yosys.worker.ts', import.meta.url), {
    type: 'module',
  })
}

function acquireYosysWorker(): Worker {
  const worker = idleYosysWorker ?? createYosysWorker()
  idleYosysWorker = null
  return worker
}

function releaseYosysWorker(worker: Worker): void {
  idleYosysWorker?.terminate()
  worker.onmessage = null
  worker.onerror = null
  idleYosysWorker = worker
}

function discardYosysWorker(worker: Worker): void {
  worker.terminate()
  if (!idleYosysWorker) idleYosysWorker = createYosysWorker()
}
