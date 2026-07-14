import { useEffect, useMemo, useState } from 'react'
import { retuneTiming } from '../api'
import { ESTIMATED_TIMING_CAVEAT, fmaxMhz } from '../lib/timing'
import {
  DELAY_FIELDS,
  PROFILE_OPTIONS,
  SPEED_GRADE_OPTIONS,
  loadTimingSettings,
  saveTimingSettings,
  timingRequest,
  type ProfileChoice,
  type TimingSettings,
} from '../lib/timingSettings'
import type { DelayModel, SpeedGrade } from '../types'

/**
 * Interactive timing panel: shows the estimated critical-path delay / Fmax and
 * lets the user retune it (delay profile, speed grade, or hand-edited
 * coefficients) via `POST /api/design/:id/timing` — no re-synthesis. Settings
 * persist in localStorage. Keyed by design id so it remounts per design.
 */
export function TimingModel({
  designId,
  fallbackDelayNs,
}: {
  designId: string
  fallbackDelayNs: number | null
}) {
  const [settings, setSettings] = useState<TimingSettings>(loadTimingSettings)
  const [result, setResult] = useState<{
    estimated_delay_ns: number | null
    model: DelayModel
  } | null>(null)
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => saveTimingSettings(settings), [settings])

  // Debounce so dragging a coefficient field doesn't spam the endpoint.
  const settingsKey = JSON.stringify(settings)
  const [debouncedKey, setDebouncedKey] = useState(settingsKey)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(settingsKey), 250)
    return () => clearTimeout(t)
  }, [settingsKey])

  useEffect(() => {
    let cancelled = false
    retuneTiming(designId, timingRequest(JSON.parse(debouncedKey) as TimingSettings))
      .then((r) => {
        if (!cancelled) setResult(r)
      })
      .catch(() => {
        // keep the last good result on a transient error
      })
    return () => {
      cancelled = true
    }
  }, [designId, debouncedKey])

  const delayNs = result?.estimated_delay_ns ?? fallbackDelayNs
  // What the editor shows: the user's override if any, else the resolved preset.
  const editorModel = settings.overrides ?? result?.model ?? null

  const setProfile = (profile: ProfileChoice) =>
    setSettings((s) => ({ ...s, profile, overrides: null }))
  const setGrade = (speedGrade: SpeedGrade) =>
    setSettings((s) => ({ ...s, speedGrade }))
  const editField = (key: keyof DelayModel, value: number) =>
    setSettings((s) => {
      const base = s.overrides ?? result?.model
      if (!base) return s
      return { ...s, overrides: { ...base, [key]: value } }
    })
  const resetOverrides = () => setSettings((s) => ({ ...s, overrides: null }))

  const fmax = useMemo(
    () => (delayNs != null && delayNs > 0 ? fmaxMhz(delayNs) : null),
    [delayNs],
  )

  return (
    <>
      <div className="section-title">Estimated timing</div>
      <div className="cards">
        <Card
          k="Critical-path delay"
          v={delayNs != null ? `${delayNs.toFixed(2)} ns` : '—'}
          accent
        />
        <Card k="Implied Fmax" v={fmax != null ? `${fmax.toFixed(0)} MHz` : '—'} />
      </div>

      <div className="timing-controls">
        <label className="field">
          <span>Delay profile</span>
          <select
            value={settings.profile}
            title="Process-node delay preset. 'Auto' uses the model chosen from the synthesis target."
            onChange={(e) => setProfile(e.target.value as ProfileChoice)}
          >
            {PROFILE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Speed grade</span>
          <select
            value={settings.speedGrade}
            title="Speed grade multiplier applied to every delay term."
            onChange={(e) => setGrade(e.target.value as SpeedGrade)}
          >
            {SPEED_GRADE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details
        className="collapsible"
        open={advanced}
        onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          Advanced: edit coefficients (ps){settings.overrides ? ' — custom' : ''}
        </summary>
        <div className="timing-coeffs">
          {DELAY_FIELDS.map((f) => (
            <CoeffInput
              key={f.key}
              label={f.label}
              value={editorModel ? editorModel[f.key] : null}
              onCommit={(n) => editField(f.key, n)}
            />
          ))}
        </div>
        {settings.overrides && (
          <button className="link-button" onClick={resetOverrides}>
            Reset to profile preset
          </button>
        )}
      </details>

      <div className="caveat" style={{ marginTop: 8 }}>
        {ESTIMATED_TIMING_CAVEAT}
      </div>
    </>
  )
}

/**
 * A single coefficient field. Keeps a local text draft so the user can clear
 * and retype freely (a controlled numeric input would snap an emptied field to
 * 0). Commits only finite, non-negative values; reverts to the model value on
 * blur when the draft is empty or invalid.
 */
function CoeffInput({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number | null
  onCommit: (n: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value != null ? String(value) : '')
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        step={5}
        value={shown}
        disabled={value == null}
        onChange={(e) => {
          const text = e.target.value
          setDraft(text)
          const n = Number(text)
          if (text.trim() !== '' && Number.isFinite(n) && n >= 0) onCommit(n)
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  )
}

function Card({
  k,
  v,
  accent,
}: {
  k: string
  v: string | number
  accent?: boolean
}) {
  return (
    <div className="card">
      <div className="k">{k}</div>
      <div className={`v${accent ? ' accent' : ''}`}>{v}</div>
    </div>
  )
}
