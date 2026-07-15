import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLineCone, getNetlist } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getLineCone', () => {
  it('sends a bounded source range and graph options', async () => {
    const response = {
      status: 'unmapped' as const,
      control: false,
      highlight: [],
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

  it('forwards cancellation to the graph request', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'mapped',
          control: false,
          highlight: [12],
          graph: { nodes: [], edges: [], truncated: false },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getLineCone(
      'design',
      { file: 'top.sv', start_line: 1, end_line: 1 },
      controller.signal,
    )

    expect(fetchMock.mock.calls[0][1]).toEqual({ signal: controller.signal })
  })
})

describe('getNetlist', () => {
  it('requests the shared 400-node default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ nodes: [], edges: [], truncated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getNetlist('design')

    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost')
    expect(url.searchParams.get('max_nodes')).toBe('400')
    expect(url.searchParams.get('hide_control')).toBe('true')
    expect(url.searchParams.get('hide_const')).toBe('false')
  })
})
