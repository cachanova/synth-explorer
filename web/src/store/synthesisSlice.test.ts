import { beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesisInput } from '../lib/synthesis/liveAnalysis'
import { createSynthesisQueue } from './synthesisSlice'

const { synthesizeMock } = vi.hoisted(() => ({
  synthesizeMock: vi.fn(),
}))

vi.mock('../lib/designClient', () => ({
  synthesize: synthesizeMock,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function input(content: string, revision: number) {
  return synthesisInput(
    [{ name: 'top.sv', content }],
    'top',
    'gates',
    '',
    revision,
  )
}

function queueHarness() {
  let revision = 1
  const onSuccess = vi.fn()
  const onError = vi.fn()
  const queue = createSynthesisQueue({
    getCurrentRevision: () => revision,
    onRunningChange: vi.fn(),
    onAttemptStart: vi.fn(),
    onSuccess,
    onError,
  })
  return {
    queue,
    onSuccess,
    onError,
    setRevision: (next: number) => {
      revision = next
    },
  }
}

describe('synthesis queue', () => {
  beforeEach(() => {
    synthesizeMock.mockReset()
  })

  it('keeps one queued slot and runs only its latest input', async () => {
    const first = deferred<never>()
    const latest = deferred<never>()
    synthesizeMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise)
    const harness = queueHarness()

    const running = harness.queue.request(input('A', 1))
    harness.setRevision(2)
    await harness.queue.request(input('B', 2))
    harness.setRevision(3)
    await harness.queue.request(input('C', 3))

    expect(synthesizeMock).toHaveBeenCalledTimes(1)
    first.resolve({} as never)
    await vi.waitFor(() => expect(synthesizeMock).toHaveBeenCalledTimes(2))
    expect(synthesizeMock.mock.calls[1][0].files[0].content).toBe('C')

    latest.resolve({} as never)
    await running
    expect(harness.onSuccess).toHaveBeenCalledTimes(2)
  })

  it('drops an obsolete queued edit when the input reverts to the running key', async () => {
    const first = deferred<never>()
    synthesizeMock.mockReturnValueOnce(first.promise)
    const harness = queueHarness()

    const running = harness.queue.request(input('A', 1))
    harness.setRevision(2)
    await harness.queue.request(input('B', 2))
    harness.setRevision(3)
    await harness.queue.request(input('A', 3))
    first.resolve({} as never)
    await running

    expect(synthesizeMock).toHaveBeenCalledTimes(1)
    expect(harness.onSuccess).toHaveBeenCalledTimes(1)
  })

  it('aborts the running request and clears queued work on invalidation', async () => {
    let observedSignal: AbortSignal | undefined
    synthesizeMock.mockImplementationOnce((_, signal: AbortSignal) => {
      observedSignal = signal
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    const harness = queueHarness()

    const running = harness.queue.request(input('A', 1))
    harness.setRevision(2)
    await harness.queue.request(input('B', 2))
    harness.queue.invalidate()
    await running

    expect(observedSignal?.aborted).toBe(true)
    expect(synthesizeMock).toHaveBeenCalledTimes(1)
    expect(harness.onSuccess).not.toHaveBeenCalled()
    expect(harness.onError).not.toHaveBeenCalled()
  })

  it('aborts the running request and clears queued work on shutdown', async () => {
    let observedSignal: AbortSignal | undefined
    synthesizeMock.mockImplementationOnce((_, signal: AbortSignal) => {
      observedSignal = signal
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    const harness = queueHarness()

    const running = harness.queue.request(input('A', 1))
    harness.setRevision(2)
    await harness.queue.request(input('B', 2))
    harness.queue.abort()
    await running

    expect(observedSignal?.aborted).toBe(true)
    expect(synthesizeMock).toHaveBeenCalledTimes(1)
    expect(harness.onSuccess).not.toHaveBeenCalled()
    expect(harness.onError).not.toHaveBeenCalled()
  })

  it('reports non-abort synthesis failures', async () => {
    const failure = new Error('synthesis failed')
    synthesizeMock.mockRejectedValueOnce(failure)
    const harness = queueHarness()

    await harness.queue.request(input('A', 1))

    expect(harness.onSuccess).not.toHaveBeenCalled()
    expect(harness.onError).toHaveBeenCalledWith(failure, expect.any(Object))
  })
})
