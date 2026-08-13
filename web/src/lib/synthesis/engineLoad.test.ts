import { describe, expect, it } from 'vitest'
import { EngineLoadError, lazyLoad } from './engineLoad'

describe('lazyLoad', () => {
  it('caches a successful load', async () => {
    let calls = 0
    const get = lazyLoad('failed to load thing', async () => ++calls)

    expect(await get()).toBe(1)
    expect(await get()).toBe(1)
    expect(calls).toBe(1)
  })

  it('shares one in-flight load among concurrent callers', async () => {
    let calls = 0
    let release!: (value: number) => void
    const get = lazyLoad('failed to load thing', () => {
      calls += 1
      return new Promise<number>((resolve) => {
        release = resolve
      })
    })

    const first = get()
    const second = get()
    release(7)

    expect(await first).toBe(7)
    expect(await second).toBe(7)
    expect(calls).toBe(1)
  })

  it('wraps failures in EngineLoadError and retries after them', async () => {
    let calls = 0
    const get = lazyLoad('failed to load thing', async () => {
      calls += 1
      if (calls === 1) throw new Error('network dropped')
      return 'ready'
    })

    const failure = await get().then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(EngineLoadError)
    expect((failure as Error).message).toBe('failed to load thing: network dropped')

    expect(await get()).toBe('ready')
    expect(calls).toBe(2)
  })
})
