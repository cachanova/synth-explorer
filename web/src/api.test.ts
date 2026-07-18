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
  LocalSynthesisError: class LocalSynthesisError extends Error {},
}))

import { ApiRequestError, getNetlist, synthesize } from './api'
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
    const request = {
      files: [{ name: 'top.sv', content: 'module top; endmodule' }],
      mode: 'gates' as const,
    }
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

  async function synthesisFailure(error: unknown): Promise<ApiRequestError> {
    engine.synthesizeLocally.mockRejectedValue(error)
    return synthesize(request).then(
      () => Promise.reject(new Error('expected synthesize to reject')),
      (raised: ApiRequestError) => raised,
    )
  }

  it('reports an engine download failure as 503, not a validation error', async () => {
    const raised = await synthesisFailure(
      new Error('failed to load the analysis engine: WebAssembly compilation aborted'),
    )
    expect(raised.status).toBe(503)
  })

  it('reports a Yosys download failure as 503', async () => {
    const raised = await synthesisFailure(new LocalSynthesisError('failed to load Yosys: status 404', ''))
    expect(raised.status).toBe(503)
  })

  it('keeps timeouts, synthesis failures, and unexpected errors distinct', async () => {
    expect((await synthesisFailure(new LocalSynthesisError('yosys timed out', ''))).status).toBe(504)
    expect((await synthesisFailure(new LocalSynthesisError('yosys failed', 'log'))).status).toBe(400)
    expect((await synthesisFailure(new Error('unexpected'))).status).toBe(422)
  })
})
