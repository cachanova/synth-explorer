import type { LineConeStatus } from '../types'

export interface SourceProbePresentation {
  acceptReturnedGraph: boolean
  highlightRoots: boolean
  retainsPreviousGraph: boolean
  message: string | null
}

export function sourceProbePresentation(
  status: LineConeStatus | null,
): SourceProbePresentation {
  switch (status) {
    case null:
      return {
        acceptReturnedGraph: true,
        highlightRoots: false,
        retainsPreviousGraph: false,
        message: null,
      }
    case 'mapped':
      return {
        acceptReturnedGraph: true,
        highlightRoots: true,
        retainsPreviousGraph: false,
        message: null,
      }
    case 'mapping_incomplete':
      return {
        acceptReturnedGraph: true,
        highlightRoots: true,
        retainsPreviousGraph: false,
        message:
          'Source mapping is incomplete because provenance limits were reached; the schematic shows only retained associations.',
      }
    case 'optimized_or_absorbed':
      return {
        acceptReturnedGraph: false,
        highlightRoots: false,
        retainsPreviousGraph: true,
        message: 'Logic for this selection was optimized away or absorbed during synthesis.',
      }
    case 'unmapped':
      return {
        acceptReturnedGraph: false,
        highlightRoots: false,
        retainsPreviousGraph: true,
        message: 'No synthesizable logic maps to this selection.',
      }
  }
}
