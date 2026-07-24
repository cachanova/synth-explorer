import { describe, expect, it } from 'vitest'
import { sourceTierMessage } from './sourceTiers'

describe('source tier messages', () => {
  it('describes approximate highlights', () => {
    expect(sourceTierMessage(false, true)).toBe(
      'Source highlight is approximate because synthesis did not preserve exact provenance for this selection.',
    )
  })

  it('describes truncated highlights', () => {
    expect(sourceTierMessage(true, false)).toBe(
      'Source highlight is partial because response limits were reached.',
    )
  })

  it('combines approximate and truncated reasons', () => {
    expect(sourceTierMessage(true, true)).toBe(
      'Source highlight is approximate because synthesis did not preserve exact provenance for this selection, and it is partial because response limits were reached.',
    )
  })

  it('omits the message for a complete exact response', () => {
    expect(sourceTierMessage(false, false)).toBeNull()
  })
})
