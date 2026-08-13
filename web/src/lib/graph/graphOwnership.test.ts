import { describe, expect, it } from 'vitest'
import { isDisplayedDesignCurrent, isRequestDesignMismatch } from './graphOwnership'

describe('displayed graph ownership', () => {
  it('allows interaction only when the laid graph belongs to the current design', () => {
    expect(isDisplayedDesignCurrent('design-b', 'design-b')).toBe(true)
    expect(isDisplayedDesignCurrent('design-b', 'design-a')).toBe(false)
    expect(isDisplayedDesignCurrent('design-b', null)).toBe(false)
    expect(isDisplayedDesignCurrent(null, 'design-a')).toBe(false)
  })
})

describe('isRequestDesignMismatch', () => {
  it('identifies a cone retained from another design', () => {
    expect(isRequestDesignMismatch('design-b', { kind: 'cone', designId: 'design-a' })).toBe(true)
    expect(isRequestDesignMismatch('design-b', { kind: 'cone', designId: 'design-b' })).toBe(false)
    expect(isRequestDesignMismatch('design-b', { kind: 'source' })).toBe(false)
    expect(isRequestDesignMismatch(null, { kind: 'cone', designId: 'design-a' })).toBe(false)
  })
})
