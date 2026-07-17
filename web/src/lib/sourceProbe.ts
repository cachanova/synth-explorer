import type { SourceSelectionStatus } from '../types'

export interface SourceProbePresentation {
  acceptReturnedGraph: boolean
  highlightSelection: boolean
  message: string | null
}

export function sourceProbePresentation(
  status: SourceSelectionStatus | null,
): SourceProbePresentation {
  switch (status) {
    case null:
      return {
        acceptReturnedGraph: true,
        highlightSelection: false,
        message: null,
      }
    case 'mapped':
      return {
        acceptReturnedGraph: true,
        highlightSelection: true,
        message: null,
      }
    case 'mapping_incomplete':
      return {
        acceptReturnedGraph: true,
        highlightSelection: true,
        message:
          'Source mapping is incomplete because provenance limits were reached; the schematic shows only retained associations.',
      }
    // Unmapped / optimized-away selections no longer render a graph here; the
    // caller falls back to the full netlist, so only the accept flag matters.
    case 'optimized_or_absorbed':
      return {
        acceptReturnedGraph: false,
        highlightSelection: false,
        message: null,
      }
    case 'unmapped':
      return {
        acceptReturnedGraph: false,
        highlightSelection: false,
        message: null,
      }
  }
}
