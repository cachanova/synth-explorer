// Types mirroring docs/API.md verbatim. Do NOT diverge from the contract.

export type NodeKind = 'cell' | 'port' | 'const'

// A node in the analysis graph. Numeric ids are stable within one design.
export interface NodeRef {
  id: number
  kind: NodeKind
  name: string // human name: cell name (cleaned), "a[3]" for port bits, "1'b0" for consts
  cell_type?: string // "$lut", "$_NAND_", "$add", "SB_LUT4", ... (kind === "cell")
  seq?: boolean // sequential cell (FF/memory/blackbox boundary)
  register?: boolean // true only for ordinary register/latch storage, not memories/SRLs/blackboxes
  src?: string // yosys src attr, e.g. "design.sv:12.16-12.21" (may be absent)
}

export interface GraphNode extends NodeRef {
  is_root?: boolean // the node the cone was requested for
  is_boundary?: boolean // traversal stopped here (startpoint/endpoint/limit)
  depth?: number // comb depth from startpoints (absent for seq/port nodes)
  params?: Record<string, string> // e.g. { "LUT": "0111...", "WIDTH": "4" }
  controls?: ControlRef[] // omitted when the node has no labeled control connections
}

export type ControlRole = 'clock' | 'reset' | 'set' | 'enable' | 'other'

export interface ControlRef {
  role: ControlRole
  pin: string
  net_name: string
  driver_id: number
  fanout: number
  active_low?: boolean
  synchronous?: boolean
  src?: string
  generated?: boolean
}

export interface GraphEdge {
  from: number // driver node id
  to: number // sink node id
  from_port: string // e.g. "Y", "Q"
  to_port: string // e.g. "A", "D"
  net_name: string // best human name for the net ("sum[3]" or "$auto$123")
  bits: number[] // yosys bit indices carried by this edge (merged parallel edges)
  control?: boolean // clock/reset/enable pin connection
}

export interface Subgraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean // hit max_nodes/max_depth; UI must say so
}

export type LineConeStatus =
  | 'mapped'
  | 'mapping_incomplete'
  | 'optimized_or_absorbed'
  | 'unmapped'

export interface LineConeResponse {
  status: LineConeStatus
  control: boolean
  graph: Subgraph
}

// --- POST /api/synthesize ---

export type Mode = 'rtl' | 'gates' | 'lut4' | 'lut6' | 'ice40' | 'ecp5' | 'xilinx'

export interface DesignFile {
  name: string // bare filename, [A-Za-z0-9._-]+, .v/.sv
  content: string
}

export interface SynthesizeRequest {
  files: DesignFile[]
  top?: string // omitted -> yosys -auto-top
  mode: Mode
  extra_args?: string // mode-specific synthesis-pass flags; safe whitespace-separated tokens
}

export interface Stats {
  num_cells: number
  cells_by_type: Record<string, number>
  num_register_bits: number
  num_register_groups: number
  num_inputs: number // port bit counts
  num_outputs: number
  max_depth: number // worst weighted structural logic depth across all endpoints
  depths: DepthSummary
  cell_categories: CellCategoryCounts
}

export interface DepthSummary {
  input_to_register: number | null
  register_to_register: number | null
  register_to_output: number | null
  input_to_output: number | null
}

export interface CellCategoryCounts {
  logic: number
  registers: number
  carry_special: number
  infrastructure: number
}

export interface SynthesizeResponse {
  design_id: string // content hash; identical input returns the same id
  top: string // resolved top module
  mode: string
  stats: Stats
  warnings: string[]
  log: string // yosys log (tail, capped)
}

// --- GET /api/design/:id/endpoints ---

export interface EndpointBit {
  bit: number
  node_id: number
  depth: number
}

export interface RegisterEndpoint {
  name: string // group name, e.g. "q" (bits grouped by stripping [i])
  width: number
  cell_type: string // representative FF type, e.g. "$_SDFF_PP0_"
  clock: string | null // net name driving CLK, null if none identified
  src?: string
  worst_depth: number // max comb depth into any bit's D
  bits: EndpointBit[]
  output_aliases: OutputAlias[]
}

export interface OutputAliasBit {
  output_bit: number
  register_bit: number
}

export interface OutputAlias {
  name: string
  width: number
  bits: OutputAliasBit[]
}

export interface OutputEndpoint {
  name: string
  width: number
  worst_depth: number
  bits: EndpointBit[]
}

export interface InputEndpoint {
  name: string
  width: number
  bits: { bit: number; node_id: number }[]
}

export interface EndpointsResponse {
  registers: RegisterEndpoint[]
  outputs: OutputEndpoint[]
  inputs: InputEndpoint[]
}

// --- GET /api/design/:id/paths ---

export type EndpointKind = 'register' | 'output' | 'blackbox'

export type PathClass =
  | 'input_to_register'
  | 'register_to_register'
  | 'register_to_output'
  | 'input_to_output'
  | 'other'

export interface TimingPath {
  depth: number // weighted structural logic levels on the path
  class: PathClass
  endpoint_group: string
  endpoint_kind: EndpointKind
  bits: number[] // endpoint bits sharing this depth and structural route
  output_aliases: OutputAlias[]
  startpoint: NodeRef // input port bit / FF cell (Q) / blackbox
  endpoint: NodeRef // FF cell (D) / output port bit / blackbox
  endpoint_port: string // "D", output port name, ...
  nodes: NodeRef[] // startpoint -> ... -> endpoint, in order
}

export interface PathsResponse {
  paths: TimingPath[]
  comb_loops: string[] // names of nodes excluded due to comb cycles
  truncated: boolean // response limit or bounded per-endpoint route sampling was hit
}

// --- GET /api/design/:id/fanout ---

export interface FanoutDriver {
  driver: NodeRef // FF cell, input port bit, or comb cell
  port: string // driving port ("Q", "Y", port name)
  net_name: string
  fanout: number // total sink pins driven
  endpoints: number // distinct sequential/output endpoints reached (direct sinks)
  control: boolean // drives clock/reset/enable pins predominantly
}

export interface FanoutResponse {
  drivers: FanoutDriver[]
}

// --- GET /api/design/:id/nodes?ids=1,2,3 ---
// Resolve node ids to display metadata. Returned in request order; unknown
// ids omitted. At most 200 ids per request (422 above that).

export interface NodesResponse {
  nodes: NodeRef[]
}

// --- GET /api/design/:id/source-map ---

export interface SourceRangeMapping {
  file: string
  start_line: number
  end_line: number
  node_ids: number[]
  mapping_incomplete: boolean
}

export interface SourceMapResponse {
  files: string[] // filenames as submitted
  by_line: Record<string, number[]> // "file.sv:12" -> node ids
  ranges: SourceRangeMapping[]
  truncated: boolean
}

// --- GET /api/examples ---

export interface Example {
  name: string // "03_adder_chain"
  title: string
  description: string
  top: string
  files: DesignFile[]
}

export interface ExamplesResponse {
  examples: Example[]
}

// --- Errors ---

export interface ApiError {
  error: string
  log?: string
}
