import type { GraphNode, Subgraph } from '../types'

/** Keep grouped nodes synthetic so the worker expands them within its normal budget. */
export function coneRootIds(node: GraphNode): number[] {
  return [node.id]
}

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
