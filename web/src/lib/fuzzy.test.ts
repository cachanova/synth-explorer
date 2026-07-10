import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyMatch, fuzzyScore } from './fuzzy'

describe('fuzzyScore / fuzzyMatch', () => {
  it('matches a subsequence', () => {
    expect(fuzzyMatch('cnt', 'counter')).toBe(true)
    expect(fuzzyMatch('cntr', 'counter')).toBe(true)
  })

  it('rejects non-subsequence', () => {
    expect(fuzzyMatch('xyz', 'counter')).toBe(false)
    expect(fuzzyMatch('ctn', 'counter')).toBe(false) // wrong order
  })

  it('is case insensitive', () => {
    expect(fuzzyMatch('CNT', 'counter')).toBe(true)
    expect(fuzzyMatch('cnt', 'COUNTER')).toBe(true)
  })

  it('empty query matches everything', () => {
    expect(fuzzyMatch('', 'anything')).toBe(true)
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('scores contiguous higher than scattered', () => {
    const contiguous = fuzzyScore('count', 'counter')
    const scattered = fuzzyScore('cnt', 'counter')
    expect(contiguous).toBeGreaterThan(scattered)
  })

  it('scores start-of-string boundary higher', () => {
    const atStart = fuzzyScore('q', 'q_reg')
    const inMiddle = fuzzyScore('q', 'aaaq')
    expect(atStart).toBeGreaterThan(inMiddle)
  })
})

describe('fuzzyFilter', () => {
  const items = ['q_reg', 'counter', 'state', 'quotient', 'sum']

  it('returns all when query blank', () => {
    expect(fuzzyFilter(items, '', (x) => x)).toEqual(items)
    expect(fuzzyFilter(items, '  ', (x) => x)).toEqual(items)
  })

  it('filters to matches only', () => {
    const res = fuzzyFilter(items, 'q', (x) => x)
    expect(res).toContain('q_reg')
    expect(res).toContain('quotient')
    expect(res).not.toContain('counter')
  })

  it('ranks better matches first', () => {
    const res = fuzzyFilter(['abcx', 'ax'], 'ax', (x) => x)
    // "ax" is a tighter contiguous match than scattered "a..x"
    expect(res[0]).toBe('ax')
  })
})
