import { describe, expect, it, vi } from 'vitest'
import {
  fetchSourceTiersForNets,
  sourceTierMessage,
} from './sourceTiers'

const { queryAnalysis } = vi.hoisted(() => ({ queryAnalysis: vi.fn() }))
vi.mock('./analysisClient', () => ({ queryAnalysis }))

describe('source tier queries', () => {
  it('sends selected net names through the net-tier worker method', async () => {
    const response = {
      exact: [],
      contributing: [],
      approximate: false,
      truncated: false,
    }
    queryAnalysis.mockResolvedValueOnce(response)

    await expect(fetchSourceTiersForNets(['sum', 'sum_alias'])).resolves.toBe(response)
    expect(queryAnalysis).toHaveBeenCalledWith(
      'sourceForNets',
      ['sum', 'sum_alias'],
    )
  })
})

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
