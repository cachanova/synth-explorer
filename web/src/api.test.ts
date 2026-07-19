import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  localCone: vi.fn(),
  localEndpoints: vi.fn(),
  localFanout: vi.fn(),
  localNetlist: vi.fn().mockResolvedValue({ nodes: [], edges: [], truncated: false }),
  localNodes: vi.fn(),
  localPaths: vi.fn(),
  localSourceMap: vi.fn(),
  localTiming: vi.fn(),
  synthesizeLocally: vi.fn(),
}))

vi.mock('./lib/localEngine', () => ({
  ...engine,
  LocalSynthesisError: class LocalSynthesisError extends Error {
    log: string
    kind?: 'load' | 'timeout'
    constructor(message: string, log = '', kind?: 'load' | 'timeout') {
      super(message)
      this.log = log
      this.kind = kind
    }
  },
}))

import { getNetlist, synthesize } from './api'
import { EngineLoadError } from './lib/engineLoad'
import { LocalSynthesisError } from './lib/localEngine'

beforeEach(() => vi.clearAllMocks())

describe('browser-local API facade', () => {
  it('uses the shared 400-node graph default without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await getNetlist('design')

    expect(engine.localNetlist).toHaveBeenCalledWith(
      'design',
      {
        max_nodes: 400,
        show_infrastructure: false,
        group_vectors: false,
        hide_control: true,
        hide_const: false,
        around: undefined,
      },
      undefined,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes synthesis to the local engine without an HTTP request', async () => {
    engine.synthesizeLocally.mockResolvedValue({ design_id: '0123456789ab' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await synthesize(request)

    expect(engine.synthesizeLocally).toHaveBeenCalledWith(request, undefined)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  const request = {
    files: [{ name: 'top.sv', content: 'module top; endmodule' }],
    mode: 'gates' as const,
  }

  it('reports an analysis engine load failure as 503, not a validation error', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new EngineLoadError('failed to load the analysis engine: aborted'),
    )
    await expect(synthesize(request)).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 503,
    })
  })

  it('reports a Yosys engine load failure as 503, even when its text mentions a timeout', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new LocalSynthesisError('failed to load Yosys: The request timed out.', '', 'load'),
    )
    await expect(synthesize(request)).rejects.toMatchObject({ status: 503 })
  })

  it('keeps timeouts, synthesis failures, and unexpected errors distinct', async () => {
    engine.synthesizeLocally.mockRejectedValue(
      new LocalSynthesisError('yosys timed out', '', 'timeout'),
    )
    await expect(synthesize(request)).rejects.toMatchObject({ status: 504 })

    engine.synthesizeLocally.mockRejectedValue(new LocalSynthesisError('yosys failed', 'log'))
    await expect(synthesize(request)).rejects.toMatchObject({ status: 400, log: 'log' })

    engine.synthesizeLocally.mockRejectedValue(new Error('unexpected'))
    await expect(synthesize(request)).rejects.toMatchObject({ status: 422 })
  })
})
