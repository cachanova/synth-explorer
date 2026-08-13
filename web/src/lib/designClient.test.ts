import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  localCone: vi.fn(),
  localEndpoints: vi.fn(),
  localExpandGroup: vi.fn(),
  localFanout: vi.fn(),
  localNetlist: vi.fn(),
  localPaths: vi.fn(),
  localTiming: vi.fn(),
  synthesizeLocally: vi.fn(),
}))

vi.mock('./synthesis/localEngine', () => engine)

import { synthesize } from './designClient'
import { EngineLoadError } from './synthesis/engineLoad'
import { LocalSynthesisError } from './synthesis/synthesisError'

const request = {
  files: [{ name: 'top.sv', content: 'module top; endmodule' }],
  mode: 'gates' as const,
}

beforeEach(() => vi.clearAllMocks())

describe('browser-local design client errors', () => {
  it('classifies an analysis engine load failure', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new EngineLoadError('failed to load the analysis engine: aborted'),
    )

    await expect(synthesize(request)).rejects.toMatchObject({
      name: 'DesignRequestError',
      kind: 'load',
    })
  })

  it('classifies a Yosys engine load failure from its kind rather than its text', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new LocalSynthesisError('failed to load Yosys: The request timed out.', '', 'load'),
    )

    await expect(synthesize(request)).rejects.toMatchObject({ kind: 'load' })
  })

  it('keeps timeouts distinct from synthesis failures', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new LocalSynthesisError('yosys timed out', '', 'timeout'),
    )
    await expect(synthesize(request)).rejects.toMatchObject({ kind: 'timeout' })

    engine.synthesizeLocally.mockRejectedValue(new LocalSynthesisError('yosys failed', 'log'))
    await expect(synthesize(request)).rejects.toMatchObject({
      kind: 'synthesis',
      log: 'log',
    })
  })

  it('classifies ordinary request failures as validation errors', async () => {
    engine.synthesizeLocally.mockRejectedValue(new Error('unexpected'))

    await expect(synthesize(request)).rejects.toMatchObject({ kind: 'validation' })
  })
})
