import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLineCone } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLineCone', () => {
  it('sends a bounded source range and graph options', async () => {
    const response = {
      status: 'unmapped' as const,
      control: false,
      graph: { nodes: [], edges: [], truncated: false },
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getLineCone('design/id', {
        file: 'source file.sv',
        start_line: 4,
        end_line: 19,
        max_nodes: 400,
        hide_control: true,
        hide_const: false,
        show_infrastructure: true,
      }),
    ).resolves.toEqual(response)

    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost')
    expect(url.pathname).toBe('/api/design/design%2Fid/line-cone')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      file: 'source file.sv',
      start_line: '4',
      end_line: '19',
      max_nodes: '400',
      hide_control: 'true',
      hide_const: 'false',
      show_infrastructure: 'true',
    })
  })
})
