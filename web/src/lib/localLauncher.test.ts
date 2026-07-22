import { describe, expect, it } from 'vitest'
import { isLocalLauncher } from './localLauncher'

describe('local launcher environment', () => {
  it('recognizes only the explicit packaged-launcher URL marker', () => {
    expect(isLocalLauncher('?launcher=1')).toBe(true)
    expect(isLocalLauncher('?launcher=0')).toBe(false)
    expect(isLocalLauncher('')).toBe(false)
  })
})
