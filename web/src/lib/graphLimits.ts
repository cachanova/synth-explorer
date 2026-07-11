export const DEFAULT_GRAPH_MAX_NODES = 400
export const MAX_GRAPH_RENDER_NODES = 2000

// Keep this synchronized with the server's merged-edge response cap. Node
// bounds alone do not protect ELK/SVG from a dense, near-complete graph.
export const MAX_GRAPH_EDGES = 10_000
