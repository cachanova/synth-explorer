import { useEffect, useMemo, useState } from 'react'
import {
  BASELINE_ELK_LAYOUT_LAB_CONFIG,
  elkLayoutStudyFromConfig,
  type ElkLayoutLabConfig,
} from '../lib/elkLayoutLab'

export interface ElkLayoutLabMetrics {
  durationMs: number
  width: number
  height: number
  routePoints: number
  bends: number
}

interface ElkLayoutLabProps {
  applied: ElkLayoutLabConfig
  applying: boolean
  metrics: ElkLayoutLabMetrics | null
  onApply: (config: ElkLayoutLabConfig) => void
}

export function ElkLayoutLab({
  applied,
  applying,
  metrics,
  onApply,
}: ElkLayoutLabProps) {
  const [draft, setDraft] = useState(applied)
  const [copied, setCopied] = useState(false)

  useEffect(() => setDraft(applied), [applied])

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(applied),
    [applied, draft],
  )
  const setNumber = (
    key: 'layerSpacing' | 'nodeSpacing' | 'edgeNodeSpacing',
    value: string,
  ) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return
    setDraft((current) => ({ ...current, [key]: parsed }))
  }
  const copySettings = async () => {
    const payload = JSON.stringify(
      {
        controls: draft,
        elk: elkLayoutStudyFromConfig(draft).layoutOptions,
      },
      null,
      2,
    )
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  const reset = () => {
    const baseline = { ...BASELINE_ELK_LAYOUT_LAB_CONFIG }
    setDraft(baseline)
    onApply(baseline)
  }

  return (
    <details className="elk-layout-lab" open>
      <summary>
        ELK layout lab <span className="elk-layout-lab-dev">DEV</span>
      </summary>
      <div className="elk-layout-lab-body">
        <p className="elk-layout-lab-note">
          Universal readability controls. Changes wait for Apply.
        </p>

        <fieldset>
          <legend>Spacing</legend>
          <label>
            Between layers
            <input
              type="number"
              min={8}
              max={240}
              step={2}
              value={draft.layerSpacing}
              onChange={(event) =>
                setNumber('layerSpacing', event.target.value)
              }
            />
          </label>
          <label>
            Between nodes
            <input
              type="number"
              min={4}
              max={160}
              step={2}
              value={draft.nodeSpacing}
              onChange={(event) => setNumber('nodeSpacing', event.target.value)}
            />
          </label>
          <label>
            Edge to node
            <input
              type="number"
              min={2}
              max={120}
              step={2}
              value={draft.edgeNodeSpacing}
              onChange={(event) =>
                setNumber('edgeNodeSpacing', event.target.value)
              }
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Routing quality</legend>
          <label>
            Greedy crossing
            <select
              value={draft.greedySwitch}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  greedySwitch: event.target
                    .value as ElkLayoutLabConfig['greedySwitch'],
                }))
              }
            >
              <option value="default">ELK default</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label>
            Thoroughness
            <select
              value={draft.thoroughness}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  thoroughness: event.target
                    .value as ElkLayoutLabConfig['thoroughness'],
                }))
              }
            >
              <option value="auto">Current automatic</option>
              <option value="1">1 · fast</option>
              <option value="4">4 · balanced</option>
              <option value="7">7 · thorough</option>
            </select>
          </label>
          <label>
            Crossing strategy
            <select
              value={draft.crossingStrategy}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  crossingStrategy: event.target
                    .value as ElkLayoutLabConfig['crossingStrategy'],
                }))
              }
            >
              <option value="default">ELK default</option>
              <option value="LAYER_SWEEP">Layer sweep</option>
              <option value="MEDIAN_LAYER_SWEEP">Median layer sweep</option>
            </select>
          </label>
          <label>
            Favor straight edges
            <select
              value={draft.favorStraightEdges}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  favorStraightEdges: event.target
                    .value as ElkLayoutLabConfig['favorStraightEdges'],
                }))
              }
            >
              <option value="default">ELK default</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="elk-layout-lab-check">
            <input
              type="checkbox"
              checked={draft.mergeEdges}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  mergeEdges: event.target.checked,
                }))
              }
            />
            Merge shared edge routes
          </label>
        </fieldset>

        {metrics && (
          <div
            className="elk-layout-lab-metrics"
            aria-label="Latest layout metrics"
          >
            <span>
              {Math.round(metrics.width)} × {Math.round(metrics.height)}
            </span>
            <span>{metrics.bends} bends</span>
            <span>{metrics.routePoints} route points</span>
            <span>{Math.round(metrics.durationMs)} ms</span>
          </div>
        )}

        <div className="elk-layout-lab-actions">
          <button
            type="button"
            className="primary"
            disabled={!dirty || applying}
            onClick={() => onApply(draft)}
          >
            {applying ? 'Laying out…' : 'Apply'}
          </button>
          <button type="button" disabled={applying} onClick={reset}>
            Baseline
          </button>
          <button type="button" onClick={() => void copySettings()}>
            {copied ? 'Copied' : 'Copy JSON'}
          </button>
        </div>
      </div>
    </details>
  )
}
