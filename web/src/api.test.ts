import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLineCone, getNetlist, synthesize, unlockVivado } from './api'

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
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
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

describe('Vivado owner access', () => {
  const accessKey =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

  it('verifies the owner key without putting it in the URL or body', async () => {
    const catalog = {
      parts: [
        { name: 'xc7a35tcpg236-1', family: 'artix7', speed: '-1' },
        { name: 'xcku025-ffva1156-2-e', family: 'kintexu', speed: '-2' },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(unlockVivado(accessKey)).resolves.toEqual(catalog)

    expect(fetchMock).toHaveBeenCalledWith('/api/vivado/access', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessKey}` },
    })
  })

  it('sends the key only for Vivado synthesis', async () => {
    const response = {
      design_id: '0123456789ab',
      top: 'top',
      tool: 'vivado',
      mode: 'gates',
      stats: {},
      warnings: [],
      log: '',
      memories_abstracted: false,
    }
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await synthesize(
      {
        files: [{ name: 'top.sv', content: 'module top; endmodule' }],
        top: 'top',
        tool: 'vivado',
        mode: 'gates',
        target: 'xc7a35tcpg236-1',
      },
      accessKey,
    )
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessKey}`,
    })

    await synthesize({
      files: [{ name: 'top.sv', content: 'module top; endmodule' }],
      mode: 'gates',
      tool: 'yosys',
    })
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      'Content-Type': 'application/json',
    })
  })
})
