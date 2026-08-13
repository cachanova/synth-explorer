export const DEFAULT_AUTO_SYNTHESIS_DELAY_MS = 250
export const MIN_AUTO_SYNTHESIS_DELAY_MS = 100
export const MAX_AUTO_SYNTHESIS_DELAY_MS = 2_000
export const AUTO_SYNTHESIS_DELAY_STEP_MS = 50

const SYNTHESIS_SETTINGS_KEY = 'synthexplorer.synthesisSettings.v1'

export interface SynthesisSettings {
  autoSynthesize: boolean
  delayMs: number
}

export const DEFAULT_SYNTHESIS_SETTINGS: SynthesisSettings = {
  autoSynthesize: true,
  delayMs: DEFAULT_AUTO_SYNTHESIS_DELAY_MS,
}

export function parseStoredSynthesisSettings(value: unknown): SynthesisSettings {
  if (!value || typeof value !== 'object') return DEFAULT_SYNTHESIS_SETTINGS
  const record = value as Record<string, unknown>
  if (
    typeof record.autoSynthesize !== 'boolean' ||
    typeof record.delayMs !== 'number' ||
    !Number.isFinite(record.delayMs)
  ) {
    return DEFAULT_SYNTHESIS_SETTINGS
  }

  return {
    autoSynthesize: record.autoSynthesize,
    delayMs: clampAutoSynthesisDelay(record.delayMs),
  }
}

export function clampAutoSynthesisDelay(delayMs: number): number {
  return Math.min(
    MAX_AUTO_SYNTHESIS_DELAY_MS,
    Math.max(MIN_AUTO_SYNTHESIS_DELAY_MS, Math.round(delayMs)),
  )
}

export function loadSynthesisSettings(): SynthesisSettings {
  try {
    const stored = localStorage.getItem(SYNTHESIS_SETTINGS_KEY)
    return stored == null
      ? DEFAULT_SYNTHESIS_SETTINGS
      : parseStoredSynthesisSettings(JSON.parse(stored))
  } catch {
    return DEFAULT_SYNTHESIS_SETTINGS
  }
}

export function saveSynthesisSettings(settings: SynthesisSettings): void {
  try {
    localStorage.setItem(SYNTHESIS_SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Keep the settings for this session when local storage is unavailable.
  }
}

export function formatSynthesisDelay(delayMs: number): string {
  return `${Number((delayMs / 1_000).toFixed(2))} s`
}
