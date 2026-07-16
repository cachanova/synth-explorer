import type {
  DelayModel,
  DelayProfile,
  SpeedGrade,
  TimingRequest,
} from '../types'

// 'auto' resolves, server-side, to the model chosen from the design's synthesis
// target — so a fresh design shows the same estimate as the synthesis panel.
export type ProfileChoice = 'auto' | DelayProfile

export interface TimingSettings {
  profile: ProfileChoice
  speedGrade: SpeedGrade
  // Full coefficient override from the advanced editor; null uses `profile`.
  overrides: DelayModel | null
  // Target clock in MHz for the slack readout; null hides it.
  targetMhz: number | null
}

export const DEFAULT_TIMING_SETTINGS: TimingSettings = {
  profile: 'auto',
  speedGrade: '-1',
  overrides: null,
  targetMhz: null,
}

export const PROFILE_OPTIONS: { value: ProfileChoice; label: string }[] = [
  { value: 'auto', label: 'Auto (from target)' },
  { value: 'series7', label: 'Xilinx 7-series' },
  { value: 'ultrascale', label: 'Xilinx UltraScale' },
  { value: 'ultrascale_plus', label: 'Xilinx UltraScale+' },
  { value: 'ice40', label: 'Lattice iCE40' },
  { value: 'ecp5', label: 'Lattice ECP5' },
  { value: 'generic', label: 'Generic (non-silicon)' },
]

export const SPEED_GRADE_OPTIONS: { value: SpeedGrade; label: string }[] = [
  { value: '-1', label: '-1 (slowest)' },
  { value: '-2', label: '-2' },
  { value: '-3', label: '-3 (fastest)' },
]

// The eight editable coefficients, in display order, with short labels.
export const DELAY_FIELDS: { key: keyof DelayModel; label: string }[] = [
  { key: 'lut_ps', label: 'LUT / gate' },
  { key: 'carry_ps', label: 'Carry stage' },
  { key: 'wide_mux_ps', label: 'Wide mux' },
  { key: 'cell_ps', label: 'Other cell' },
  { key: 'ff_clk_to_q_ps', label: 'FF clk→Q' },
  { key: 'ff_setup_ps', label: 'FF setup' },
  { key: 'net_base_ps', label: 'Net base' },
  { key: 'net_per_fanout_ps', label: 'Net /fanout' },
]

const STORAGE_KEY = 'synthexplorer.timing.v1'

/** Map settings to a `/timing` request. Precedence mirrors the server: a full
 *  override wins for the coefficients, then a named profile, then (auto) the
 *  design's own model.
 *
 *  `profile` is sent independently of `model`, because the server reads it for
 *  two different things: which coefficients to start from, and which family's
 *  speed-grade scaling to apply. Suppressing it when overrides exist would
 *  leave the dropdown showing one family while the server scaled by another. */
export function timingRequest(s: TimingSettings): TimingRequest {
  const req: TimingRequest = { speed_grade: s.speedGrade }
  if (s.overrides) req.model = s.overrides
  if (s.profile !== 'auto') req.profile = s.profile
  return req
}

/** True when the settings reproduce the design's synth-time estimate exactly. */
export function isDefaultTiming(s: TimingSettings): boolean {
  return s.profile === 'auto' && s.speedGrade === '-1' && !s.overrides
}

const DELAY_KEYS: (keyof DelayModel)[] = DELAY_FIELDS.map((f) => f.key)

function isDelayModel(value: unknown): value is DelayModel {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return DELAY_KEYS.every((k) => typeof v[k] === 'number' && isFinite(v[k] as number))
}

export function loadTimingSettings(): TimingSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_TIMING_SETTINGS
    const parsed = JSON.parse(raw) as Partial<TimingSettings>
    const profile = PROFILE_OPTIONS.some((o) => o.value === parsed.profile)
      ? (parsed.profile as ProfileChoice)
      : 'auto'
    const speedGrade = SPEED_GRADE_OPTIONS.some((o) => o.value === parsed.speedGrade)
      ? (parsed.speedGrade as SpeedGrade)
      : '-1'
    const overrides = isDelayModel(parsed.overrides) ? parsed.overrides : null
    const targetMhz =
      typeof parsed.targetMhz === 'number' &&
      isFinite(parsed.targetMhz) &&
      parsed.targetMhz > 0
        ? parsed.targetMhz
        : null
    return { profile, speedGrade, overrides, targetMhz }
  } catch {
    return DEFAULT_TIMING_SETTINGS
  }
}

export function saveTimingSettings(s: TimingSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // storage unavailable (private mode / quota) — settings just won't persist
  }
}
