import type {
  DelayModel,
  DelayProfile,
  GateDelays,
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
  { value: 'sky130hd', label: 'SkyWater 130nm (sky130hd)' },
  { value: 'gf180mcu', label: 'GlobalFoundries 180nm (gf180mcu)' },
  { value: 'asap7', label: 'ASAP7 (predictive 7nm)' },
  { value: 'generic', label: 'Generic (non-silicon)' },
]

const FPGA_PROFILES: ProfileChoice[] = [
  'auto',
  'series7',
  'ultrascale',
  'ultrascale_plus',
  'ice40',
  'ecp5',
  'generic',
]
const ASIC_PROFILES: ProfileChoice[] = [
  'auto',
  'sky130hd',
  'gf180mcu',
  'asap7',
  'generic',
]

/** The profiles that make sense for a design's synthesis mode. A gates-mode
 *  netlist is generic gates headed for standard cells — FPGA LUT/carry presets
 *  don't describe it; an FPGA or LUT-mapped netlist is the reverse, so it gets
 *  no ASIC process nodes. Unknown/absent mode falls back to the full list. */
export function profilesForMode(
  mode?: string,
): { value: ProfileChoice; label: string }[] {
  const allowed =
    mode === 'gates'
      ? ASIC_PROFILES
      : mode === 'xilinx' ||
          mode === 'ice40' ||
          mode === 'ecp5' ||
          mode === 'lut4' ||
          mode === 'lut6'
        ? FPGA_PROFILES
        : null
  if (!allowed) return PROFILE_OPTIONS
  return PROFILE_OPTIONS.filter((o) => allowed.includes(o.value))
}

/** A stored profile can be invalid for the design being viewed (settings are
 *  global; the user may have picked sky130hd on a gates design and then opened
 *  a Xilinx one). Fall back to 'auto' rather than retuning an FPGA netlist
 *  with standard-cell numbers or vice versa. */
export function effectiveProfile(
  profile: ProfileChoice,
  mode?: string,
): ProfileChoice {
  return profilesForMode(mode).some((o) => o.value === profile)
    ? profile
    : 'auto'
}

// ASIC standard-cell profiles are characterized at a single corner (TT); there
// is no speed-grade binning and the server applies no grade scaling to them.
export const PDK_PROFILES: ReadonlySet<ProfileChoice> = new Set([
  'sky130hd',
  'gf180mcu',
  'asap7',
])

export const SPEED_GRADE_OPTIONS: { value: SpeedGrade; label: string }[] = [
  { value: '-1', label: '-1 (slowest)' },
  { value: '-2', label: '-2' },
  { value: '-3', label: '-3 (fastest)' },
]

// ECP5's real speed grades are named 6/7/8, with 6 the slowest — the grade the
// preset is characterized at. The wire format keeps '-1'/'-2'/'-3'; only the
// labels change: '-2' maps to grade 7 and '-3' to grade 8 (prjtrellis-measured
// factors on the server).
export const ECP5_SPEED_GRADE_OPTIONS: { value: SpeedGrade; label: string }[] = [
  { value: '-1', label: '6 (slowest)' },
  { value: '-2', label: '7' },
  { value: '-3', label: '8 (fastest)' },
]

/** Labels for the speed-grade select. ECP5 shows its real grade names (6/7/8);
 *  `designMode` resolves the 'auto' profile when the design itself was
 *  synthesized for an ECP5 target. */
export function speedGradeOptions(
  profile: ProfileChoice,
  designMode?: string,
): { value: SpeedGrade; label: string }[] {
  const isEcp5 =
    profile === 'ecp5' || (profile === 'auto' && designMode === 'ecp5')
  return isEcp5 ? ECP5_SPEED_GRADE_OPTIONS : SPEED_GRADE_OPTIONS
}

type FlatDelayKey = Exclude<keyof DelayModel, 'gate_ps'>

// The legacy FPGA/generic coefficients, in display order, with short labels.
export const DELAY_FIELDS: { key: FlatDelayKey; label: string }[] = [
  { key: 'lut_ps', label: 'LUT / gate' },
  { key: 'carry_ps', label: 'Carry stage' },
  { key: 'wide_mux_ps', label: 'Wide mux' },
  { key: 'cell_ps', label: 'Other cell' },
  { key: 'ff_clk_to_q_ps', label: 'FF clk→Q' },
  { key: 'ff_setup_ps', label: 'FF setup' },
  { key: 'net_base_ps', label: 'Net base' },
  { key: 'net_per_fanout_ps', label: 'Net /fanout' },
]

export const ASIC_GATE_FIELDS: { key: keyof GateDelays; label: string }[] = [
  { key: 'and', label: 'AND' },
  { key: 'or', label: 'OR' },
  { key: 'xor', label: 'XOR' },
  { key: 'nand', label: 'NAND' },
  { key: 'nor', label: 'NOR' },
  { key: 'xnor', label: 'XNOR' },
  { key: 'mux', label: 'MUX' },
  { key: 'not', label: 'NOT' },
]

// Register and interconnect terms are shared with the flat model, but the ASIC
// editor names registers as DFFs and deliberately omits FPGA-only vocabulary.
export const ASIC_SHARED_FIELDS: { key: FlatDelayKey; label: string }[] = [
  { key: 'cell_ps', label: 'Other gate' },
  { key: 'ff_clk_to_q_ps', label: 'DFF clk→Q' },
  { key: 'ff_setup_ps', label: 'DFF setup' },
  { key: 'net_base_ps', label: 'Net base' },
  { key: 'net_per_fanout_ps', label: 'Net /fanout' },
]

/** Effective standard-cell gate price. Sparse/uncharacterized categories use
 * the profile's documented `cell_ps` blend. */
export function gateDelayValue(
  model: DelayModel,
  key: keyof GateDelays,
): number {
  return model.gate_ps?.[key] ?? model.cell_ps
}

/** Return a full override with one gate category edited, preserving the sparse
 * table and every flat/shared coefficient. */
export function withGateDelay(
  model: DelayModel,
  key: keyof GateDelays,
  value: number,
): DelayModel {
  return {
    ...model,
    gate_ps: { ...model.gate_ps, [key]: value },
  }
}

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

/** Global settings may carry an override created for a different technology
 * class; suppress it rather than
 * applying standard-cell gate coefficients to an FPGA netlist (or a legacy
 * flat override to a named PDK profile). */
export function compatibleTimingOverrides(
  settings: TimingSettings,
  mode?: string,
): DelayModel | null {
  if (!settings.overrides) return null
  const profile = effectiveProfile(settings.profile, mode)
  const pdkActive = PDK_PROFILES.has(profile)
  const overrideIsPdk = settings.overrides.gate_ps !== undefined
  return pdkActive === overrideIsPdk ? settings.overrides : null
}

/** Select the model that may seed the coefficient editor. A compatible active
 * override wins; otherwise a server response is usable only when it belongs to
 * the current request, never to the profile that was selected previously. */
export function editorModelForRequest(
  activeOverrides: DelayModel | null,
  result: { model: DelayModel; requestKey: string } | null,
  requestKey: string,
): DelayModel | null {
  if (activeOverrides) return activeOverrides
  return result?.requestKey === requestKey ? result.model : null
}

/** Build a timing request using the profile and compatible override for one
 * design mode. */
export function timingRequestForMode(
  settings: TimingSettings,
  mode?: string,
): TimingRequest {
  const profile = effectiveProfile(settings.profile, mode)
  const overrides = compatibleTimingOverrides(settings, mode)
  return timingRequest({ ...settings, profile, overrides })
}

/** True when the settings reproduce the design's synth-time estimate exactly. */
export function isDefaultTiming(s: TimingSettings): boolean {
  return s.profile === 'auto' && s.speedGrade === '-1' && !s.overrides
}

const DELAY_KEYS: FlatDelayKey[] = DELAY_FIELDS.map((f) => f.key)
const GATE_DELAY_KEYS: (keyof GateDelays)[] = ASIC_GATE_FIELDS.map(
  (f) => f.key,
)

function isGateDelays(value: unknown): value is GateDelays {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  const allowed = new Set<string>(GATE_DELAY_KEYS)
  return Object.entries(v).every(
    ([key, entry]) =>
      allowed.has(key) &&
      typeof entry === 'number' &&
      isFinite(entry as number),
  )
}

function isDelayModel(value: unknown): value is DelayModel {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    DELAY_KEYS.every(
      (k) => typeof v[k] === 'number' && isFinite(v[k] as number),
    ) &&
    (v.gate_ps === undefined || isGateDelays(v.gate_ps))
  )
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
