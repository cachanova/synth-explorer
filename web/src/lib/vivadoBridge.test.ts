import { describe, expect, it } from 'vitest'
import { vivadoBridgeOrigin } from './vivadoBridge'

describe('Vivado bridge origin', () => {
  it('keeps the hosted website and packaged launcher on separate fixed ports', () => {
    expect(vivadoBridgeOrigin('')).toBe('http://127.0.0.1:32123')
    expect(vivadoBridgeOrigin('?launcher=1')).toBe('http://127.0.0.1:32125')
  })
})
