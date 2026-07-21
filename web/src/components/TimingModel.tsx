import { useEffect, useMemo, useState } from 'react'
import { retuneTiming } from '../api'
import { fmaxMhz } from '../lib/timing'
import {
  ASIC_GATE_FIELDS,
  ASIC_SHARED_FIELDS,
  DELAY_FIELDS,
  PDK_PROFILES,
  compatibleTimingOverrides,
  editorModelForRequest,
  gateDelayValue,
  loadTimingSettings,
  resolveTimingView,
  saveTimingSettings,
  timingRequestForView,
  withGateDelay,
  type ProfileChoice,
  type TimingSettings,
} from '../lib/timingSettings'
import type {
  DelayBreakdown,
  DelayModel,
  DelayProfile,
  GateDelays,
  SpeedGrade,
} from '../types'
import { Card } from './Card'

/**
 * Interactive timing panel: shows the estimated critical-path delay / Fmax and
 * lets the user retune it (delay profile, speed grade, or hand-edited
 * coefficients) in the browser — no re-synthesis. Settings persist in
 * localStorage. Keyed by design id so it remounts per design.
 */
export function TimingModel({
  designId,
  designMode,
  resolvedProfile,
  fallbackDelayNs,
  fallbackBreakdown,
}: {
  designId: string
  // The design's synthesis platform (e.g. 'ecp5'), so the speed-grade select can
  // label ECP5's real grade names even when the profile is 'auto'.
  designMode?: string
  // Synthesis-resolved family. Concrete FPGA designs lock to this value.
  resolvedProfile: DelayProfile
  fallbackDelayNs: number | null
  fallbackBreakdown?: DelayBreakdown
}) {
  const [settings, setSettings] = useState<TimingSettings>(loadTimingSettings)
  const [result, setResult] = useState<{
    estimated_delay_ns: number | null
    estimated_delay_breakdown?: DelayBreakdown
    model: DelayModel
    requestKey: string
  } | null>(null)
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => saveTimingSettings(settings), [settings])

  const view = useMemo(
    () => resolveTimingView(settings, designMode, resolvedProfile),
    [settings, designMode, resolvedProfile],
  )
  // Debounce so dragging a coefficient field doesn't spam the endpoint.
  const requestKey = JSON.stringify(timingRequestForView(settings, view))
  const [debouncedKey, setDebouncedKey] = useState(requestKey)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(requestKey), 250)
    return () => clearTimeout(t)
  }, [requestKey])

  useEffect(() => {
    let cancelled = false
    retuneTiming(designId, JSON.parse(debouncedKey))
      .then((r) => {
        if (!cancelled) setResult({ ...r, requestKey: debouncedKey })
      })
      .catch(() => {
        // keep the last good result on a transient error
      })
    return () => {
      cancelled = true
    }
  }, [designId, debouncedKey])

  const delayNs = result?.estimated_delay_ns ?? fallbackDelayNs
  const breakdown = result?.estimated_delay_breakdown ?? fallbackBreakdown
  // What the editor shows: the compatible user override if any, else a preset
  // response that belongs to the current request. A profile switch leaves the
  // prior response on screen briefly; never let an edit clone that stale model.
  const activeOverrides = compatibleTimingOverrides(settings, view)
  const editorModel = editorModelForRequest(
    activeOverrides,
    result,
    requestKey,
  )

  const setProfile = (profile: ProfileChoice) =>
    setSettings((s) => ({ ...s, profile, overrides: null }))
  const setGrade = (speedGrade: SpeedGrade) =>
    setSettings((s) => ({ ...s, speedGrade }))
  const editField = (
    key: Exclude<keyof DelayModel, 'gate_ps'>,
    value: number,
  ) =>
    setSettings((s) => {
      const base = editorModelForRequest(
        compatibleTimingOverrides(s, view),
        result,
        requestKey,
      )
      if (!base) return s
      return { ...s, overrides: { ...base, [key]: value } }
    })
  const editGateField = (key: keyof GateDelays, value: number) =>
    setSettings((s) => {
      const base = editorModelForRequest(
        compatibleTimingOverrides(s, view),
        result,
        requestKey,
      )
      if (!base) return s
      return {
        ...s,
        overrides: withGateDelay(base, key, value),
      }
    })
  const resetOverrides = () => setSettings((s) => ({ ...s, overrides: null }))

  const fmax = useMemo(
    () => (delayNs != null && delayNs > 0 ? fmaxMhz(delayNs) : null),
    [delayNs],
  )

  const profileLabel =
    view.profileOptions.find((option) => option.value === view.profile)?.label ??
    view.profile

  return (
    <>
      {view.showTiming && (
        <>
          <div className="section-title">Estimated timing</div>
          <div className="cards">
            <Card
              k="Critical-path delay"
              v={delayNs != null ? `${delayNs.toFixed(2)} ns` : '—'}
              accent
            />
            <Card
              k="Implied Fmax"
              v={fmax != null ? `${fmax.toFixed(0)} MHz` : '—'}
            />
          </div>

          {breakdown && delayNs != null && delayNs > 0 && (
            <BreakdownBar breakdown={breakdown} total={delayNs} />
          )}
        </>
      )}

      <div className="timing-controls">
        <label className="field">
          <span>Delay profile</span>
          {view.profileLocked ? (
            <span className="timing-profile-fixed">{profileLabel}</span>
          ) : (
            <select
              value={view.profile}
              title="Delay preset for this design's technology. 'Auto' leaves generic designs without absolute timing."
              onChange={(e) => setProfile(e.target.value as ProfileChoice)}
            >
              {view.profileOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </label>
        {view.showGradeSection && (
          <label className="field">
            <span>Speed grade</span>
            <select
              value={view.grade}
              title="Speed-grade multiplier applied to every delay term."
              onChange={(e) => setGrade(e.target.value as SpeedGrade)}
            >
              {view.gradeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {!view.showTiming && designMode !== 'rtl' && (
        <div className="empty-state timing-profile-placeholder">
          {designMode === 'gates'
            ? 'Pick a process node from the Delay profile menu to estimate absolute timing.'
            : 'Pick an FPGA preset from the Delay profile menu to estimate absolute timing.'}
        </div>
      )}

      {view.showTiming && (
        <details
          className="collapsible"
          open={advanced}
          onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Advanced: edit coefficients (ps){activeOverrides ? ' — custom' : ''}
          </summary>
          <div className="timing-coeffs">
            {PDK_PROFILES.has(view.profile) ? (
              <>
                {ASIC_GATE_FIELDS.map((f) => (
                  <CoeffInput
                    key={`gate-${f.key}`}
                    label={f.label}
                    value={
                      editorModel ? gateDelayValue(editorModel, f.key) : null
                    }
                    onCommit={(n) => editGateField(f.key, n)}
                  />
                ))}
                {ASIC_SHARED_FIELDS.map((f) => (
                  <CoeffInput
                    key={f.key}
                    label={f.label}
                    value={editorModel ? editorModel[f.key] : null}
                    onCommit={(n) => editField(f.key, n)}
                  />
                ))}
              </>
            ) : (
              DELAY_FIELDS.map((f) => (
                <CoeffInput
                  key={f.key}
                  label={f.label}
                  value={editorModel ? editorModel[f.key] : null}
                  onCommit={(n) => editField(f.key, n)}
                />
              ))
            )}
          </div>
          {activeOverrides && (
            <button className="link-button" onClick={resetOverrides}>
              Reset to profile preset
            </button>
          )}
        </details>
      )}

      {view.showTiming && (
        <div className="caveat" style={{ marginTop: 8 }}>
          {view.caveat}
        </div>
      )}
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

const BREAKDOWN_SEGMENTS: {
  key: keyof DelayBreakdown
  label: string
  cls: string
}[] = [
  { key: 'launch_ns', label: 'Launch', cls: 'bd-launch' },
  { key: 'logic_ns', label: 'Logic', cls: 'bd-logic' },
  { key: 'net_ns', label: 'Routing', cls: 'bd-net' },
  { key: 'setup_ns', label: 'Setup', cls: 'bd-setup' },
]

function BreakdownBar({
  breakdown,
  total,
}: {
  breakdown: DelayBreakdown
  total: number
}) {
  // Only categories that contribute — keeps the bar and legend consistent (a
  // primary-input path has no launch; a comb-output path has no setup).
  const segments = BREAKDOWN_SEGMENTS.map((s) => ({
    ...s,
    ns: breakdown[s.key],
    pct: (breakdown[s.key] / total) * 100,
  })).filter((s) => s.ns > 0)
  return (
    <div className="breakdown">
      <div className="breakdown-bar" title="Where the estimated delay goes">
        {segments.map(
          (s) =>
            s.pct > 0 && (
              <span
                key={s.key}
                className={`breakdown-seg ${s.cls}`}
                style={{ width: `${s.pct}%` }}
              />
            ),
        )}
      </div>
      <div className="breakdown-legend">
        {segments.map((s) => (
          <span key={s.key} className="breakdown-item">
            <span className={`breakdown-swatch ${s.cls}`} />
            {s.label} {s.ns.toFixed(2)} ns
          </span>
        ))}
      </div>
    </div>
  )
}
