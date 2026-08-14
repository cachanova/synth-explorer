import { LocalSynthesisError, abortError } from '../synthesis/synthesisError'

interface PooledWorkerConfig<WorkerResponse, Result> {
  label: string
  timeoutMs: number
  mapResponse: (response: WorkerResponse) => Result
}

type ToolWorkerResponse<Result> =
  | { ok: true; result: Result }
  | { ok: false; error: string; kind?: 'load'; log?: string }

export function mapToolWorkerResponse<Result>(
  response: ToolWorkerResponse<Result>,
  fallbackError = '',
): Result {
  if (response.ok) return response.result
  throw new LocalSynthesisError(
    response.error || fallbackError,
    response.log ?? '',
    response.kind,
  )
}

/**
 * Creates a runner for caller-serialized, disposable WASM tool workers such as
 * Yosys and GHDL. The caller owns request serialization; this helper owns the
 * idle-worker, timeout, abort, and termination lifecycle. This is intentionally
 * not for the id-multiplexed, persistent workers in analysisClient.ts or the
 * graph layout client; those have different lifecycles and remain separate.
 */
export function createPooledWorkerRunner<Request, WorkerResponse, Result>(
  createWorker: () => Worker,
  config: PooledWorkerConfig<WorkerResponse, Result>,
): (request: Request, signal?: AbortSignal) => Promise<Result> {
  let idleWorker: Worker | null = null
  const displayLabel = config.label.replace(/^./, (letter) => letter.toUpperCase())

  const acquireWorker = () => {
    const worker = idleWorker ?? createWorker()
    idleWorker = null
    return worker
  }

  const releaseWorker = (worker: Worker) => {
    idleWorker?.terminate()
    worker.onmessage = null
    worker.onerror = null
    idleWorker = worker
  }

  const discardWorker = (worker: Worker) => {
    worker.terminate()
    if (!idleWorker) idleWorker = createWorker()
  }

  return (request, signal) => {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      let worker: Worker
      try {
        worker = acquireWorker()
      } catch (error) {
        reject(error)
        return
      }

      let settled = false
      const finish = (settle: () => void, reusable: boolean) => {
        if (settled) return false
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        settle()
        try {
          if (reusable) releaseWorker(worker)
          else discardWorker(worker)
        } catch {
          idleWorker = null
          worker.onmessage = null
          worker.onerror = null
          try {
            worker.terminate()
          } catch {
            // The request is already settled; a later call will retry worker creation.
          }
        }
        return true
      }
      const onAbort = () => {
        finish(() => reject(abortError()), false)
      }
      const timeout = setTimeout(() => {
        finish(
          () =>
            reject(new LocalSynthesisError(`${config.label} timed out`, '', 'timeout')),
          false,
        )
      }, config.timeoutMs)
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        finish(() => {
          try {
            resolve(config.mapResponse(event.data))
          } catch (error) {
            reject(error)
          }
        }, true)
      }
      worker.onerror = (event) => {
        finish(
          () =>
            reject(
              new LocalSynthesisError(
                event.message || `failed to load the ${displayLabel} worker`,
                '',
                'load',
              ),
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
}
