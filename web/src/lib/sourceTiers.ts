import { queryAnalysis } from './analysisClient'

export interface SourceTierSpan {
  file: string
  start_line: number
  end_line: number
  start_column?: number
  end_column?: number
}

export interface SourceTiersResponse {
  exact: SourceTierSpan[]
  contributing: SourceTierSpan[]
  approximate: boolean
  truncated: boolean
}

/** Backend query lands with the wasm rebuild; the method name is final. */
export function fetchSourceTiers(nodeIds: number[]): Promise<SourceTiersResponse> {
  return queryAnalysis('sourceForNodes', nodeIds)
}

export function sourceTierMessage(
  truncated: boolean,
  approximate: boolean,
): string | null {
  if (truncated && approximate) {
    return 'Source highlight is approximate because synthesis did not preserve exact provenance for this selection, and it is partial because response limits were reached.'
  }
  if (truncated) {
    return 'Source highlight is partial because response limits were reached.'
  }
  if (approximate) {
    return 'Source highlight is approximate because synthesis did not preserve exact provenance for this selection.'
  }
  return null
}
