import type { SourceSelectionStatus } from '../types'

export interface SourceProbePresentation {
  acceptReturnedGraph: boolean
  showDirectSelection: boolean
  message: string | null
}

export function sourceProbePresentation(
  status: SourceSelectionStatus | null,
): SourceProbePresentation {
  switch (status) {
    case null:
      return {
        acceptReturnedGraph: true,
        showDirectSelection: false,
        message: null,
      }
    case 'mapped':
      return {
        acceptReturnedGraph: true,
        showDirectSelection: true,
        message: null,
      }
    case 'mapping_incomplete':
      return {
        acceptReturnedGraph: true,
        showDirectSelection: true,
        message:
          'Source mapping is incomplete because provenance limits were reached; the schematic shows only retained associations.',
      }
    // Unmapped / optimized-away selections no longer render a graph here; the
    // caller falls back to the full netlist, so only the accept flag matters.
    case 'optimized_or_absorbed':
      return {
        acceptReturnedGraph: false,
        showDirectSelection: false,
        message: null,
      }
    case 'unmapped':
      return {
        acceptReturnedGraph: false,
        showDirectSelection: false,
        message: null,
      }
  }
}

export function sourceRangeProbeMessage(
  truncated: boolean,
  approximate: boolean,
): string | null {
  if (truncated && approximate) {
    return 'Source highlight is approximate, and some source locations were omitted because response limits were reached.'
  }
  if (truncated) {
    return 'Source highlight is partial because some source locations were omitted by response limits.'
  }
  if (approximate) {
    return 'Source highlight is approximate because synthesis did not preserve exact wire provenance.'
  }
  return null
}
