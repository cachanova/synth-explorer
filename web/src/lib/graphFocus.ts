import type { Subgraph } from '../types'
import { mergeSubgraphs } from './mergeSubgraph'

export interface FocusGraphPresentation {
  graph: Subgraph
  relevanceHighlight: number[]
}

export interface FocusGraphVisibility {
  hideControl: boolean
  hideConst: boolean
}

function applyVisibility(
  graph: Subgraph,
  visibility: FocusGraphVisibility,
): Subgraph {
  if (!visibility.hideControl && !visibility.hideConst) return graph
  const nodes = visibility.hideConst
    ? graph.nodes.filter((node) => node.kind !== 'const')
    : graph.nodes
  const visible = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: graph.edges.filter(
      (edge) =>
        visible.has(edge.from) &&
        visible.has(edge.to) &&
        (!visibility.hideControl || !edge.control),
    ),
    truncated: graph.truncated,
  }
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
  visibility: FocusGraphVisibility = {
    hideControl: false,
    hideConst: false,
  },
): FocusGraphPresentation {
  if (focus || full == null) return { graph: relevant, relevanceHighlight: [] }
  return {
    graph: mergeSubgraphs(relevant, applyVisibility(full, visibility), cap),
    relevanceHighlight: relevant.nodes.map((node) => node.id),
  }
}
