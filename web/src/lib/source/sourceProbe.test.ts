import { describe, expect, it } from 'vitest'
import { sourceProbePresentation } from './sourceProbe'

describe('source probe presentation', () => {
  it('renders retained roots for incomplete mapping without claiming optimization', () => {
    const presentation = sourceProbePresentation('mapping_incomplete')

    expect(presentation.acceptReturnedGraph).toBe(true)
    expect(presentation.showDirectSelection).toBe(true)
    expect(presentation.message).toContain('mapping is incomplete')
    expect(presentation.message).toContain('retained associations')
    expect(presentation.message).not.toMatch(/optimi[sz]ed|absorbed/i)
  })

  it('rejects the returned graph for unmapped/optimized selections so the caller can fall back', () => {
    expect(sourceProbePresentation('mapped').acceptReturnedGraph).toBe(true)
    expect(sourceProbePresentation('optimized_or_absorbed').acceptReturnedGraph).toBe(false)
    expect(sourceProbePresentation('unmapped').acceptReturnedGraph).toBe(false)
  })
})
