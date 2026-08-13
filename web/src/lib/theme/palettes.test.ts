import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODE,
  DEFAULT_PALETTE,
  PALETTES,
  isMode,
  isPaletteId,
  resolveMode,
} from './palettes'

describe('palette registry', () => {
  it('defaults to Tidepool + system', () => {
    expect(DEFAULT_PALETTE).toBe('tidepool')
    expect(DEFAULT_MODE).toBe('system')
    expect(isPaletteId(DEFAULT_PALETTE)).toBe(true)
  })

  it('has unique ids and a valid swatch per palette', () => {
    const ids = PALETTES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PALETTES) {
      for (const hex of Object.values(p.swatch)) {
        expect(hex).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('rejects unknown ids and modes', () => {
    expect(isPaletteId('nope')).toBe(false)
    expect(isPaletteId(undefined)).toBe(false)
    expect(isMode('bright')).toBe(false)
    expect(isMode('dark')).toBe(true)
  })
})

describe('resolveMode', () => {
  it('follows the system preference under system mode', () => {
    expect(resolveMode('tidepool', 'system', true)).toBe('dark')
    expect(resolveMode('tidepool', 'system', false)).toBe('light')
  })

  it('honors an explicit light/dark choice regardless of system', () => {
    expect(resolveMode('tidepool', 'light', true)).toBe('light')
    expect(resolveMode('tidepool', 'dark', false)).toBe('dark')
  })

  it('forces dark for a dark-only palette no matter the mode', () => {
    expect(resolveMode('dracula', 'light', false)).toBe('dark')
    expect(resolveMode('synthwave', 'system', false)).toBe('dark')
    expect(resolveMode('dracula', 'dark', true)).toBe('dark')
  })
})
