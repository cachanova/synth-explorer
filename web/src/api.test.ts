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

import { getNetlist, synthesize } from './api'

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

    expect(engine.synthesizeLocally).toHaveBeenCalledWith(request)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
