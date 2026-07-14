import type { Subgraph } from '../types'
import { mergeSubgraphs } from './mergeSubgraph'

export interface FocusGraphPresentation {
  graph: Subgraph
  relevanceHighlight: number[]
}

/**
 * Focus on renders exactly the requested cone. Focus off keeps that cone as
 * the priority portion of a capped full-netlist view and highlights every
 * node the focused view would have shown.
 */
export function presentGraphForFocus(
  relevant: Subgraph,
  full: Subgraph | null,
  focus: boolean,
  cap: number,
): FocusGraphPresentation {
  if (focus || full == null) return { graph: relevant, relevanceHighlight: [] }
  return {
    graph: mergeSubgraphs(relevant, full, cap),
    relevanceHighlight: relevant.nodes.map((node) => node.id),
  }
}
