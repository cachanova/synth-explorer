import { describe, expect, it } from 'vitest'
import { naturalCompare } from './naturalCompare'

describe('naturalCompare', () => {
  it('orders embedded numbers by value, not lexicographically', () => {
    expect(naturalCompare('d_in[2]', 'd_in[10]')).toBeLessThan(0)
    expect(naturalCompare('d_in[10]', 'd_in[2]')).toBeGreaterThan(0)
    expect(naturalCompare('new_n9', 'new_n27')).toBeLessThan(0)
  })

  it('returns 0 for equal strings', () => {
    expect(naturalCompare('q_reg', 'q_reg')).toBe(0)
    expect(naturalCompare('a[3]', 'a[3]')).toBe(0)
  })

  it('falls back to lexicographic order for plain names', () => {
    expect(naturalCompare('alpha', 'beta')).toBeLessThan(0)
    expect(naturalCompare('beta', 'alpha')).toBeGreaterThan(0)
  })

  it('sorts a bus in natural bit order', () => {
    const names = ['d_in[10]', 'd_in[2]', 'd_in[0]', 'd_in[1]']
    expect([...names].sort(naturalCompare)).toEqual([
      'd_in[0]',
      'd_in[1]',
      'd_in[2]',
      'd_in[10]',
    ])
  })
})
