import type {
  DelayModel,
  DelayProfile,
  GateDelays,
  SpeedGrade,
  TimingRequest,
} from '../types'
import { estimatedTimingCaveat } from './timing'

// 'auto' resolves in the analysis worker to the model chosen from synthesis
// target — so a fresh design shows the same estimate as the synthesis panel.
export type ProfileChoice = 'auto' | DelayProfile

export interface TimingSettings {
  profile: ProfileChoice
  speedGrade: SpeedGrade
  // Full coefficient override from the advanced editor; null uses `profile`.
  overrides: DelayModel | null
}

export const DEFAULT_TIMING_SETTINGS: TimingSettings = {
  profile: 'auto',
  speedGrade: '-1',
  overrides: null,
}

const PROFILE_OPTIONS: { value: ProfileChoice; label: string }[] = [
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
const LUT_PROFILES: ProfileChoice[] = [
  'auto',
  'series7',
  'ultrascale',
  'ultrascale_plus',
  'ice40',
  'ecp5',
]
const ASIC_PROFILES: ProfileChoice[] = [
  'auto',
  'sky130hd',
  'gf180mcu',
  'asap7',
]

/** The profiles that make sense for a design's synthesis mode. A gates-mode
 *  netlist is generic gates headed for standard cells — FPGA LUT/carry presets
 *  don't describe it; an FPGA or LUT-mapped netlist is the reverse, so it gets
 *  no ASIC process nodes. Gates/LUT menus omit `generic`: `auto` is their
 *  notional no-absolute-timing placeholder until a real profile is selected.
 *  Unknown/absent mode falls back to the full list. */
function profilesForMode(
  mode?: string,
): { value: ProfileChoice; label: string }[] {
  let allowed: ProfileChoice[] | null = null
  if (mode === 'gates') {
    allowed = ASIC_PROFILES
  } else if (mode === 'lut4' || mode === 'lut6') {
    allowed = LUT_PROFILES
  } else if (mode === 'xilinx' || mode === 'ice40' || mode === 'ecp5') {
    allowed = FPGA_PROFILES
  }
  if (!allowed) return PROFILE_OPTIONS
  return PROFILE_OPTIONS.filter((o) => allowed.includes(o.value))
}

// ASIC standard-cell profiles are characterized at a single corner (TT); there
// is no speed-grade binning and analysis applies no grade scaling to them.
export const PDK_PROFILES: ReadonlySet<ProfileChoice> = new Set([
  'sky130hd',
  'gf180mcu',
  'asap7',
])

const SPEED_GRADE_OPTIONS: { value: SpeedGrade; label: string }[] = [
  { value: '-1', label: '-1 (slowest)' },
  { value: '-2', label: '-2' },
  { value: '-3', label: '-3 (fastest)' },
]

// ECP5's real speed grades are named 6/7/8, with 6 the slowest — the grade the
// preset is characterized at. The wire format keeps '-1'/'-2'/'-3'; only the
// labels change: '-2' maps to grade 7 and '-3' to grade 8 (prjtrellis-measured
// factors on the server).
const ECP5_SPEED_GRADE_OPTIONS: { value: SpeedGrade; label: string }[] = [
  { value: '-1', label: '6 (slowest)' },
  { value: '-2', label: '7' },
  { value: '-3', label: '8 (fastest)' },
]

const ICE40_SPEED_GRADE_OPTIONS: { value: SpeedGrade; label: string }[] = [
  { value: 'hx', label: 'HX' },
  { value: 'lp', label: 'LP' },
]

export interface TimingView {
  profile: ProfileChoice
  profileLocked: boolean
  profileOptions: { value: ProfileChoice; label: string }[]
  grade: SpeedGrade
  gradeOptions: { value: SpeedGrade; label: string }[]
  showTiming: boolean
  showGradeSection: boolean
  caveat: string
}

function gradeOptionsForProfile(
  profile: ProfileChoice,
): { value: SpeedGrade; label: string }[] {
  if (profile === 'ice40') return ICE40_SPEED_GRADE_OPTIONS
  if (profile === 'ecp5') return ECP5_SPEED_GRADE_OPTIONS
  return SPEED_GRADE_OPTIONS
}

function lockedTimingMode(mode?: string): boolean {
  return mode === 'xilinx' || mode === 'ice40' || mode === 'ecp5'
}

/** Resolve global persisted preferences into the one effective timing view for
 * a concrete design. All renderers and requests consume this value, never raw
 * settings fields whose validity depends on the design. */
export function resolveTimingView(
  settings: TimingSettings,
  designMode: string | undefined,
  resolvedProfile: DelayProfile,
): TimingView {
  const selectableProfiles = profilesForMode(designMode)
  const profileLocked = lockedTimingMode(designMode)
  const profile = profileLocked
    ? resolvedProfile
    : selectableProfiles.some((option) => option.value === settings.profile)
      ? settings.profile
      : 'auto'
  const profileOptions =
    designMode === 'rtl'
      ? []
      : profileLocked
        ? PROFILE_OPTIONS.filter((option) => option.value === resolvedProfile)
        : selectableProfiles
  const showTiming =
    designMode !== 'rtl' &&
    !(
      (designMode === 'gates' || designMode === 'lut4' || designMode === 'lut6') &&
      profile === 'auto'
    )
  const showGradeSection =
    showTiming && designMode !== 'gates' && !PDK_PROFILES.has(profile)
  const availableGrades = gradeOptionsForProfile(profile)
  const grade = availableGrades.some((option) => option.value === settings.speedGrade)
    ? settings.speedGrade
    : profile === 'ice40'
      ? 'hx'
      : '-1'

  return {
    profile,
    profileLocked,
    profileOptions,
    grade,
    gradeOptions: showGradeSection ? availableGrades : [],
    showTiming,
    showGradeSection,
    caveat: showTiming ? estimatedTimingCaveat(profile === 'auto' ? resolvedProfile : profile) : '',
  }
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
function timingRequest(
  view: TimingView,
  overrides: DelayModel | null,
): TimingRequest {
  const req: TimingRequest = { speed_grade: view.grade }
  if (overrides) req.model = overrides
  if (view.profile !== 'auto') req.profile = view.profile
  return req
}

/** Global settings may carry an override created for a different technology
 * class; suppress it rather than
 * applying standard-cell gate coefficients to an FPGA netlist (or a legacy
 * flat override to a named PDK profile). */
export function compatibleTimingOverrides(
  settings: TimingSettings,
  view: TimingView,
): DelayModel | null {
  if (!settings.overrides) return null
  const pdkActive = PDK_PROFILES.has(view.profile)
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

/** Build a timing request from the resolved per-design view and only a
 * technology-compatible override. */
export function timingRequestForView(
  settings: TimingSettings,
  view: TimingView,
): TimingRequest {
  return timingRequest(view, compatibleTimingOverrides(settings, view))
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
    const speedGrade = [...SPEED_GRADE_OPTIONS, ...ICE40_SPEED_GRADE_OPTIONS].some((o) => o.value === parsed.speedGrade)
      ? (parsed.speedGrade as SpeedGrade)
      : '-1'
    const overrides = isDelayModel(parsed.overrides) ? parsed.overrides : null
    return { profile, speedGrade, overrides }
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
