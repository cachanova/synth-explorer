export const DEFAULT_GRAPH_MAX_NODES = 400
export const MAX_GRAPH_RENDER_NODES = 2000
// A deliberate local group expansion may open a 2,048-instance inferred
// memory plus immediate context without raising the ordinary request stepper.
export const MAX_GROUP_EXPANSION_RENDER_NODES = 4096
// Opening or closing a group re-projects every open group, and each one becomes
// an ELK compound. Keep this synchronized with MAX_EXPANDED_GROUPS in
// analysis-wasm, which rejects a larger open set.
export const MAX_OPEN_EXPANDED_GROUPS = 8

// Keep this synchronized with analysis_core::MAX_SUBGRAPH_EDGES. Node
// bounds alone do not protect ELK/SVG from a dense, near-complete graph.
export const MAX_GRAPH_EDGES = 10_000
