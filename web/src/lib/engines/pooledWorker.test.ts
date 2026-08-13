import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPooledWorkerRunner } from './pooledWorker'

class FakeWorker {
  onmessage: Worker['onmessage'] = null
  onerror: Worker['onerror'] = null
  postMessage = vi.fn()
  terminate = vi.fn()

  respond(data: string): void {
    this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent<string>)
  }

  fail(message: string): void {
    this.onerror?.call(this as unknown as AbstractWorker, { message } as ErrorEvent)
  }
}

function setup() {
  const workers: FakeWorker[] = []
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  const runPooledWorker = createPooledWorkerRunner<string, string, string>(createWorker)
  const run = (signal?: AbortSignal) =>
    runPooledWorker('request', {
      timeoutMs: 1_000,
      signal,
      onResponse(response, resolve) {
        resolve(response)
      },
      timeoutError: () => new Error('timed out'),
      workerError: (event) => new Error(event.message),
    })
  return { createWorker, run, workers }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('pooled worker', () => {
  it('reuses a worker after a successful response', async () => {
    const { createWorker, run, workers } = setup()

    const first = run()
    workers[0].respond('first')
    await expect(first).resolves.toBe('first')

    const second = run()
    expect(createWorker).toHaveBeenCalledOnce()
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
    workers[0].respond('second')
    await expect(second).resolves.toBe('second')
  })

  it('terminates and replaces a worker that fails', async () => {
    const { createWorker, run, workers } = setup()

    const result = run()
    workers[0].fail('worker failed')

    await expect(result).rejects.toThrow('worker failed')
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(createWorker).toHaveBeenCalledTimes(2)
  })

  it('terminates and replaces a worker after the timeout', async () => {
    vi.useFakeTimers()
    const { createWorker, run, workers } = setup()

    const result = run()
    const rejection = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(1_000)

    await rejection
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(createWorker).toHaveBeenCalledTimes(2)
  })

  it('terminates and replaces an aborted worker', async () => {
    const { createWorker, run, workers } = setup()
    const controller = new AbortController()

    const result = run(controller.signal)
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(createWorker).toHaveBeenCalledTimes(2)
  })
})
