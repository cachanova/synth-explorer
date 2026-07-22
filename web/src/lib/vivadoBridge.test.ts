import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectVivadoBridge, vivadoBridgeOrigin } from './vivadoBridge'

const status = {
  protocol_version: 2,
  bridge_version: '0.2.1-test',
  vivado_version: 'Vivado v2026.1',
  parts: [{ name: 'xc7a35tcpg236-1', family: 'artix7', speed: '-1' }],
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Vivado bridge origin', () => {
  it('keeps the hosted website and packaged launcher on separate fixed ports', () => {
    expect(vivadoBridgeOrigin('')).toBe('http://127.0.0.1:32123')
    expect(vivadoBridgeOrigin('?launcher=1')).toBe('http://127.0.0.1:32125')
  })

  it('asks the local launcher to start Vivado only when connecting', async () => {
    vi.stubGlobal('window', { location: { search: '?launcher=1' } })
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => status,
    }))
    vi.stubGlobal('fetch', fetch)

    await expect(connectVivadoBridge()).resolves.toEqual(status)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('/launcher/vivado/start', expect.objectContaining({
      method: 'POST',
      body: '{}',
    }))
  })

  it('passes an explicitly selected Vivado path to the launcher', async () => {
    vi.stubGlobal('window', { location: { search: '?launcher=1' } })
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => status,
    }))
    vi.stubGlobal('fetch', fetch)

    await connectVivadoBridge('/opt/Xilinx/Vivado/bin/vivado')
    expect(fetch).toHaveBeenCalledWith('/launcher/vivado/start', expect.objectContaining({
      body: JSON.stringify({ vivado: '/opt/Xilinx/Vivado/bin/vivado' }),
    }))
  })

  it('leaves the hosted website connector flow unchanged', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => status,
    }))
    vi.stubGlobal('fetch', fetch)

    await connectVivadoBridge()
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:32123/v1/status',
      expect.objectContaining({ mode: 'cors' }),
    )
  })
})
