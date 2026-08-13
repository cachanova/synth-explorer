import { abortError } from '../synthesis/synthesisError'

interface PooledWorkerRunOptions<Response, Result> {
  timeoutMs: number
  signal?: AbortSignal
  onResponse: (
    response: Response,
    resolve: (value: Result | PromiseLike<Result>) => void,
    reject: (reason?: unknown) => void,
  ) => void
  timeoutError: () => unknown
  workerError: (event: ErrorEvent) => unknown
}

export function createPooledWorkerRunner<Request, Response, Result>(
  createWorker: () => Worker,
): (
  request: Request,
  options: PooledWorkerRunOptions<Response, Result>,
) => Promise<Result> {
  let idleWorker: Worker | null = null

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

  return (request, options) => {
    const worker = acquireWorker()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (action: () => void, reusable: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
        if (reusable) releaseWorker(worker)
        else discardWorker(worker)
        action()
      }
      const onAbort = () => finish(() => reject(abortError()), false)
      const timeout = setTimeout(() => {
        finish(() => reject(options.timeoutError()), false)
      }, options.timeoutMs)
      worker.onmessage = (event: MessageEvent<Response>) => {
        finish(() => options.onResponse(event.data, resolve, reject), true)
      }
      worker.onerror = (event) => {
        finish(() => reject(options.workerError(event)), false)
      }
      if (options.signal?.aborted) return onAbort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        worker.postMessage(request)
      } catch (error) {
        finish(() => reject(error), false)
      }
    })
  }
}
