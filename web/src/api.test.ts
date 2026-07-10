import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLineCone, getNetlist, synthesize } from './api'
import {
  MAX_RETRY_DELAY_MS,
  MIN_RETRY_DELAY_MS,
  parseRetryAfterMs,
} from './lib/retry'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Retry-After handling', () => {
  it('exposes the bounded server delay on synthesis errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'synthesis capacity exhausted' }), {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '5',
          },
        }),
      ),
    )

    await expect(
      synthesize({ files: [{ name: 'top.sv', content: 'module top; endmodule' }], mode: 'gates' }),
    ).rejects.toMatchObject({
      status: 503,
      retryAfterMs: 5_000,
      message: 'synthesis capacity exhausted',
    })
  })

  it('rejects invalid values and bounds zero or excessive delays', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('')).toBeUndefined()
    expect(parseRetryAfterMs('-1')).toBeUndefined()
    expect(parseRetryAfterMs('1.5')).toBeUndefined()
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT')).toBeUndefined()
    expect(parseRetryAfterMs('0')).toBe(MIN_RETRY_DELAY_MS)
    expect(parseRetryAfterMs('999999999999')).toBe(MAX_RETRY_DELAY_MS)
  })
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

  it('forwards cancellation to the graph request', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'mapped',
          control: false,
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
  })
})
