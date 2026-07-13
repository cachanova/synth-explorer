import type { AnalysisState } from '../store'

/**
 * Honesty chip shown above analysis tables whose rows come from the previous
 * synthesis — matches the Schematic tab's banner styling. Renders nothing when
 * the analysis is current (or when there are no results at all).
 */
export function StaleResultsChip({ state }: { state: AnalysisState }) {
  if (state === 'current' || state === 'none') return null
  return (
    <div className="stale-chip-row">
      <span className="stale-chip">showing previous results — refreshing</span>
    </div>
  )
}
