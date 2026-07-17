import { afterEach, describe, expect, it, vi } from 'vitest'
import { getNetlist, synthesize, unlockVivado } from './api'

afterEach(() => {
  vi.unstubAllGlobals()
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

  it('prioritizes context around the relevant graph roots', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ nodes: [], edges: [], truncated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await getNetlist('design', { max_nodes: 800, around: [12, 34] })

    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost')
    expect(url.searchParams.get('max_nodes')).toBe('800')
    expect(url.searchParams.get('around')).toBe('12,34')
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
      delay_profile: 'series7',
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
