import { describe, expect, it } from 'vitest'
import { isDisplayedDesignCurrent } from './graphOwnership'

describe('displayed graph ownership', () => {
  it('allows interaction only when the laid graph belongs to the current design', () => {
    expect(isDisplayedDesignCurrent('design-b', 'design-b')).toBe(true)
    expect(isDisplayedDesignCurrent('design-b', 'design-a')).toBe(false)
    expect(isDisplayedDesignCurrent('design-b', null)).toBe(false)
    expect(isDisplayedDesignCurrent(null, 'design-a')).toBe(false)
  })
})
