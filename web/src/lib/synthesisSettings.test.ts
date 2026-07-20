import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNTHESIS_SETTINGS,
  MAX_AUTO_SYNTHESIS_DELAY_MS,
  MIN_AUTO_SYNTHESIS_DELAY_MS,
  parseStoredSynthesisSettings,
} from './synthesisSettings'

describe('synthesis settings', () => {
  it('restores valid automatic synthesis preferences', () => {
    expect(
      parseStoredSynthesisSettings({
        autoSynthesize: false,
        delayMs: 750,
      }),
    ).toEqual({ autoSynthesize: false, delayMs: 750 })
  })

  it('falls back to automatic synthesis with a 250 ms delay', () => {
    expect(DEFAULT_SYNTHESIS_SETTINGS).toEqual({
      autoSynthesize: true,
      delayMs: 250,
    })
    expect(parseStoredSynthesisSettings(null)).toEqual(
      DEFAULT_SYNTHESIS_SETTINGS,
    )
    expect(parseStoredSynthesisSettings({ autoSynthesize: 'yes', delayMs: 0 })).toEqual(
      DEFAULT_SYNTHESIS_SETTINGS,
    )
  })

  it('clamps stored delays to the supported slider range', () => {
    expect(
      parseStoredSynthesisSettings({ autoSynthesize: true, delayMs: -20 }),
    ).toEqual({
      autoSynthesize: true,
      delayMs: MIN_AUTO_SYNTHESIS_DELAY_MS,
    })
    expect(
      parseStoredSynthesisSettings({ autoSynthesize: true, delayMs: 99_000 }),
    ).toEqual({
      autoSynthesize: true,
      delayMs: MAX_AUTO_SYNTHESIS_DELAY_MS,
    })
  })
})
