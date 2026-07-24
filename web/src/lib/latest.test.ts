import { describe, expect, it } from 'vitest'
import { createLatestGuard } from './latest'

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
})
