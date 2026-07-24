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
