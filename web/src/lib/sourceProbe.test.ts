import { describe, expect, it } from 'vitest'
import { sourceProbePresentation } from './sourceProbe'

describe('source probe presentation', () => {
  it('renders retained roots for incomplete mapping without claiming optimization', () => {
    const presentation = sourceProbePresentation('mapping_incomplete')

    expect(presentation.acceptReturnedGraph).toBe(true)
    expect(presentation.highlightRoots).toBe(true)
    expect(presentation.retainsPreviousGraph).toBe(false)
    expect(presentation.message).toContain('mapping is incomplete')
    expect(presentation.message).toContain('retained associations')
    expect(presentation.message).not.toMatch(/optimi[sz]ed|absorbed/i)
  })

  it('retains the prior graph only when the selected source has no returned graph', () => {
    expect(sourceProbePresentation('mapped').retainsPreviousGraph).toBe(false)
    expect(sourceProbePresentation('optimized_or_absorbed').retainsPreviousGraph).toBe(true)
    expect(sourceProbePresentation('unmapped').retainsPreviousGraph).toBe(true)
  })
})
