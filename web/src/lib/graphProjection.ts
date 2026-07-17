import type { Subgraph } from '../types'

/**
 * Choose the graph whose geometry is rendered. Selection changes are styling-
 * only outside Focus, so they must retain the full schematic's object identity.
 */
export function graphProjection(
  full: Subgraph | null,
  relevant: Subgraph | null,
  focus: boolean,
): Subgraph | null {
  return focus ? relevant : full
}
