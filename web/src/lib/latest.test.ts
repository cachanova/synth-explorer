import { describe, expect, it } from 'vitest'
import { createLatestGuard, createLatestRequestQueue } from './latest'

/** Manually resolvable promise, to script completion order. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createLatestGuard', () => {
  it('newest token is current, older tokens are stale', () => {
    const g = createLatestGuard()
    const a = g.begin()
    expect(g.current()).toBe(a)
    expect(g.isCurrent(a)).toBe(true)
    const b = g.begin()
    expect(g.current()).toBe(b)
    expect(g.isCurrent(a)).toBe(false)
    expect(g.isCurrent(b)).toBe(true)
  })

  it('slow earlier request cannot overwrite a newer result (out-of-order completion)', async () => {
    const g = createLatestGuard()
    let design: string | null = null
    let synthesizing = false

    // Mirrors an async commit plus spinner guarded by the token.
    async function synthesize(task: Promise<string>) {
      const token = g.begin()
      synthesizing = true
      try {
        const res = await task
        if (!g.isCurrent(token)) return
        design = res
      } finally {
        if (g.isCurrent(token)) synthesizing = false
      }
    }

    const slow = deferred<string>()
    const fast = deferred<string>()

    const p1 = synthesize(slow.promise) // started first, resolves last
    const p2 = synthesize(fast.promise) // started second, resolves first

    fast.resolve('NEW')
    await p2
    expect(design).toBe('NEW')
    expect(synthesizing).toBe(false)

    slow.resolve('OLD')
    await p1
    // the stale request must not overwrite the newer design
    expect(design).toBe('NEW')
    expect(synthesizing).toBe(false)
  })

  it('stale request does not clear the spinner while the newer one is in flight', async () => {
    const g = createLatestGuard()
    let synthesizing = false

    async function synthesize(task: Promise<string>) {
      const token = g.begin()
      synthesizing = true
      try {
        await task
      } finally {
        if (g.isCurrent(token)) synthesizing = false
      }
    }

    const slow = deferred<string>()
    const fast = deferred<string>()

    const p1 = synthesize(slow.promise)
    const p2 = synthesize(fast.promise)

    // the OLD request finishes first (e.g. server error) while NEW is in flight
    slow.resolve('OLD')
    await p1
    expect(synthesizing).toBe(true) // spinner must stay on for the newer request

    fast.resolve('NEW')
    await p2
    expect(synthesizing).toBe(false)
  })

  it('stale errors are also suppressed', async () => {
    const g = createLatestGuard()
    let error: string | null = null

    async function synthesize(task: Promise<string>) {
      const token = g.begin()
      try {
        await task
      } catch (e) {
        if (!g.isCurrent(token)) return
        error = String(e)
      }
    }

    const slow = deferred<string>()
    const fast = deferred<string>()

    const p1 = synthesize(slow.promise)
    const p2 = synthesize(fast.promise)

    fast.resolve('ok')
    await p2
    slow.reject(new Error('boom'))
    await p1

    expect(error).toBeNull() // stale failure must not surface
  })
})

describe('createLatestRequestQueue', () => {
  it('runs one request at a time, replaces queued work, and commits only the latest result', async () => {
    const first = deferred<string>()
    const latest = deferred<string>()
    const started: string[] = []
    const committed: string[] = []
    const tasks = new Map([
      ['first', first],
      ['latest', latest],
    ])
    const queue = createLatestRequestQueue(
      (request: string) => {
        started.push(request)
        return tasks.get(request)!.promise
      },
      (result) => committed.push(result),
      () => undefined,
    )

    queue.schedule('first')
    queue.schedule('replaced')
    queue.schedule('latest')
    expect(started).toEqual(['first'])

    first.resolve('stale result')
    await first.promise
    await Promise.resolve()
    expect(started).toEqual(['first', 'latest'])
    expect(committed).toEqual([])

    latest.resolve('current result')
    await latest.promise
    await Promise.resolve()
    expect(committed).toEqual(['current result'])
  })

  it('cancel invalidates running work and drops queued work', async () => {
    const first = deferred<string>()
    const started: string[] = []
    const committed: string[] = []
    const queue = createLatestRequestQueue(
      (request: string) => {
        started.push(request)
        return first.promise
      },
      (result) => committed.push(result),
      () => undefined,
    )

    queue.schedule('running')
    queue.schedule('queued')
    queue.cancel()
    first.resolve('stale result')
    await first.promise
    await Promise.resolve()

    expect(started).toEqual(['running'])
    expect(committed).toEqual([])
  })

  it('suppresses stale failures while retaining the latest queued request', async () => {
    const first = deferred<string>()
    const latest = deferred<string>()
    const failures: string[] = []
    const committed: string[] = []
    const queue = createLatestRequestQueue(
      (request: string) => (request === 'first' ? first.promise : latest.promise),
      (result) => committed.push(result),
      (error) => failures.push(String(error)),
    )

    queue.schedule('first')
    queue.schedule('latest')
    first.reject(new Error('stale failure'))
    await first.promise.catch(() => undefined)
    await Promise.resolve()
    expect(failures).toEqual([])

    latest.resolve('current result')
    await latest.promise
    await Promise.resolve()
    expect(committed).toEqual(['current result'])
  })
})
