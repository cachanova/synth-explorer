// Guard for racy async flows: only the most recently started request may
// commit its result. Each call to begin() invalidates all earlier tokens.

export interface LatestGuard {
  /** Start a new request; returns its token and invalidates older ones. */
  begin(): number
  /** Capture the current token without invalidating in-flight work. */
  current(): number
  /** True iff no newer request has begun since this token was issued. */
  isCurrent(token: number): boolean
}

export interface LatestRequestQueue<Input> {
  /** Run now when idle, otherwise replace the single queued request. */
  schedule(input: Input): void
  /** Invalidate running work and discard the queued request. */
  cancel(): void
}

export function createLatestGuard(): LatestGuard {
  let seq = 0
  return {
    begin() {
      return ++seq
    },
    current() {
      return seq
    },
    isCurrent(token: number) {
      return token === seq
    },
  }
}

/**
 * Serialize async work with one replaceable pending slot. Results and failures
 * commit only when they belong to the newest scheduled request.
 */
export function createLatestRequestQueue<Input, Output>(
  run: (input: Input) => Promise<Output>,
  commit: (output: Output, input: Input) => void,
  fail: (error: unknown, input: Input) => void,
): LatestRequestQueue<Input> {
  const guard = createLatestGuard()
  let running = false
  let queued: { input: Input; token: number } | null = null

  const drain = async (first: { input: Input; token: number }) => {
    let current: { input: Input; token: number } | null = first
    while (current) {
      queued = null
      try {
        const output = await run(current.input)
        if (guard.isCurrent(current.token)) commit(output, current.input)
      } catch (error) {
        if (guard.isCurrent(current.token)) fail(error, current.input)
      }
      current = queued
    }
    running = false
  }

  return {
    schedule(input) {
      const request = { input, token: guard.begin() }
      if (running) {
        queued = request
        return
      }
      running = true
      void drain(request)
    },
    cancel() {
      guard.begin()
      queued = null
    },
  }
}
