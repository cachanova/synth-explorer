import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FILE } from '../data/defaultWorkspace'
import { synthesisKey } from './designCache'
import { getPrecomputedSynthesis } from './precomputedSynthesis'
import { validateSynthesisRequest } from './yosysScript'

const input = validateSynthesisRequest({
  files: [DEFAULT_FILE],
  mode: 'gates',
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('getPrecomputedSynthesis', () => {
  it('does not request an artifact for an unlisted custom input', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(getPrecomputedSynthesis('unlisted', input)).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects a malformed artifact and allows local fallback', async () => {
    const key = await synthesisKey(input)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
    )

    await expect(getPrecomputedSynthesis(key, input)).resolves.toBeNull()
  })

  it('forwards cancellation to a pending edge request', async () => {
    const key = await synthesisKey(input)
    let fetchSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const pendingSignal = init?.signal as AbortSignal | undefined
        if (!pendingSignal) throw new Error('fetch signal is missing')
        fetchSignal = pendingSignal
        return new Promise<Response>((_resolve, reject) => {
          pendingSignal.addEventListener('abort', () => reject(pendingSignal.reason), {
            once: true,
          })
        })
      }),
    )
    const controller = new AbortController()

    const result = getPrecomputedSynthesis(key, input, controller.signal)
    controller.abort()

    await expect(result).resolves.toBeNull()
    expect(fetchSignal?.aborted).toBe(true)
  })

  it('times out a stalled edge request so local synthesis can proceed', async () => {
    vi.useFakeTimers()
    const key = await synthesisKey(input)
    let fetchSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const pendingSignal = init?.signal as AbortSignal | undefined
        if (!pendingSignal) throw new Error('fetch signal is missing')
        fetchSignal = pendingSignal
        return new Promise<Response>((_resolve, reject) => {
          pendingSignal.addEventListener('abort', () => reject(pendingSignal.reason), {
            once: true,
          })
        })
      }),
    )

    const result = getPrecomputedSynthesis(key, input)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(result).resolves.toBeNull()
    if (!fetchSignal) throw new Error('fetch signal was not captured')
    expect(fetchSignal.reason).toBeInstanceOf(DOMException)
    expect((fetchSignal.reason as DOMException).name).toBe('TimeoutError')
  })
})
