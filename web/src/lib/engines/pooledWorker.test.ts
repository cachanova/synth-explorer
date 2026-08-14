import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPooledWorkerRunner, mapToolWorkerResponse } from './pooledWorker'

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

function setup(mapResponse: (response: string) => string = (response) => response) {
  const workers: FakeWorker[] = []
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  const runPooledWorker = createPooledWorkerRunner<string, string, string>(
    createWorker,
    { label: 'test', timeoutMs: 1_000, mapResponse },
  )
  const run = (signal?: AbortSignal) => runPooledWorker('request', signal)
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
    const rejection = expect(result).rejects.toThrow('test timed out')
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

  it('rejects a pre-aborted request without evicting the warm worker', async () => {
    const { createWorker, run, workers } = setup()
    const first = run()
    workers[0].respond('first')
    await expect(first).resolves.toBe('first')

    const controller = new AbortController()
    controller.abort()

    await expect(run(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })

    const second = run()
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
    workers[0].respond('second')
    await expect(second).resolves.toBe('second')
    expect(createWorker).toHaveBeenCalledOnce()
    expect(workers[0].terminate).not.toHaveBeenCalled()
  })

  it('returns a rejected promise when worker creation throws', async () => {
    const createWorker = vi.fn(() => {
      throw new Error('worker creation failed')
    })
    const run = createPooledWorkerRunner<string, string, string>(createWorker, {
      label: 'test',
      timeoutMs: 1_000,
      mapResponse: (response) => response,
    })

    await expect(run('request')).rejects.toThrow('worker creation failed')
  })

  it('settles even when eager replacement worker creation throws', async () => {
    const workers: FakeWorker[] = []
    const createWorker = vi.fn(() => {
      if (workers.length > 0) throw new Error('replacement failed')
      const worker = new FakeWorker()
      workers.push(worker)
      return worker as unknown as Worker
    })
    const run = createPooledWorkerRunner<string, string, string>(createWorker, {
      label: 'test',
      timeoutMs: 1_000,
      mapResponse: (response) => response,
    })

    const result = run('request')
    expect(() => workers[0].fail('worker failed')).not.toThrow()
    await expect(result).rejects.toThrow('worker failed')
  })

  it('cleans up after postMessage throws', async () => {
    vi.useFakeTimers()
    const { createWorker, run, workers } = setup()
    const originalCreate = createWorker.getMockImplementation()
    createWorker.mockImplementationOnce(() => {
      const worker = originalCreate!()
      ;(worker.postMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('post failed')
      })
      return worker
    })

    await expect(run()).rejects.toThrow('post failed')
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(createWorker).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a late response after timing out', async () => {
    vi.useFakeTimers()
    const mapResponse = vi.fn((response: string) => response)
    const { run, workers } = setup(mapResponse)

    const result = run()
    const rejection = expect(result).rejects.toThrow('test timed out')
    await vi.advanceTimersByTimeAsync(1_000)
    workers[0].respond('late')

    await rejection
    expect(mapResponse).not.toHaveBeenCalled()
  })

  it('rejects when the response mapper throws', async () => {
    const { createWorker, run, workers } = setup(() => {
      throw new Error('mapping failed')
    })

    const result = run()
    workers[0].respond('response')

    await expect(result).rejects.toThrow('mapping failed')
    expect(workers[0].terminate).not.toHaveBeenCalled()
    expect(createWorker).toHaveBeenCalledOnce()
  })

  it('maps tool responses and preserves structured failure details', () => {
    expect(mapToolWorkerResponse({ ok: true, result: 'done' })).toBe('done')

    expect(() =>
      mapToolWorkerResponse(
        { ok: false, error: '', log: 'worker log', kind: 'load' },
        'fallback failure',
      ),
    ).toThrow(
      expect.objectContaining({
        name: 'LocalSynthesisError',
        message: 'fallback failure',
        log: 'worker log',
        kind: 'load',
      }),
    )
  })
})
