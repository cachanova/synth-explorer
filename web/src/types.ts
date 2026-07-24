// Shared contracts between the browser UI and its local workers.

export type NodeKind = 'cell' | 'port' | 'const'

// A node in the analysis graph. Numeric ids are stable within one design.
export interface NodeRef {
  id: number
  kind: NodeKind
  name: string // human name: cell name (cleaned), "a[3]" for port bits, "1'b0" for consts
  port_direction?: 'input' | 'output' | 'inout' // present only for top-level ports
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
  // A group enabled by group_vectors or group_memories: a synthetic node.
  // Structural-vector groups collapse two or more projected graph members;
  // logical-memory groups may wrap one physical primitive to preserve their
  // source-level shape. `members` are the real physical node ids represented.
  width?: number
  // Canonical group size; may exceed `width` in a bounded projection.
  member_count?: number
  members?: number[]
  // Ordered physical lanes of a grouped top-level port. `bit` is the
  // declaration slot, not a Yosys net id.
  boundary_members?: BoundaryMember[]
}

export interface BoundaryMember {
  member: number
  bit: number
}

export interface EdgeBoundaryMember {
  member: number
  net_bits: number[]
}

export type ControlRole = 'clock' | 'reset' | 'set' | 'enable' | 'other'

export interface ControlRef {
  role: ControlRole
  pin: string
  net_name: string
  driver_id: number
  // Present when one grouped-control row represents multiple distinct nets.
  driver_ids?: number[]
  net_count?: number
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
  control?: boolean // labeled global control; logic-generated enables remain dataflow edges
  // Exact physical grouped-boundary members contributing to either side of
  // this collapsed edge. Omitted when that side is not a grouped top-level port.
  source_boundary_members?: EdgeBoundaryMember[]
  target_boundary_members?: EdgeBoundaryMember[]
}

export interface Subgraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean // hit max_nodes/max_depth; UI must say so
}

export interface GroupExpansion {
  graph: Subgraph
  /** Raw physical node ids belonging to the expanded canonical group. */
  members: number[]
  /** Exact compact quotient trunks replaced by expanded member edges. */
  boundary_trunks: GroupExpansionBoundaryTrunk[]
}

export interface GroupExpansionBoundaryTrunk {
  compact_edge: ProjectedEdgeKey
  expanded_edges: ProjectedEdgeKey[]
}

export interface ProjectedEdgeKey {
  from: number
  to: number
  from_port: string
  to_port: string
}

export type SourceSelectionStatus =
  | 'mapped'
  | 'mapping_incomplete'
  | 'optimized_or_absorbed'
  | 'unmapped'

export interface SourceSelectionResult {
  status: SourceSelectionStatus
  control: boolean
  /** Displayed graph nodes directly attributable to the selected source range. */
  directIds: number[]
  /** Final Yosys net-bit ids directly named by the selected declaration. */
  directBits: number[]
  graph: Subgraph
}

// --- Browser-local synthesis ---

export type Mode =
  | 'rtl'
  | 'gates'
  | 'lut4'
  | 'lut6'
  | 'ice40'
  | 'ecp5'
  | 'xilinx'

export type SynthTool = 'yosys' | 'vivado'

// synth_xilinx -family target; selects carry/BRAM/DSP primitives.
export type XilinxFamily = 'xc7' | 'xcup' | 'xcu' | 'xc6s' | 'xc6v'

export interface DesignFile {
  name: string // bare filename, [A-Za-z0-9._-]+, .v/.sv/.svh/.vhd/.vhdl
  content: string
}

export interface SynthesizeRequest {
  files: DesignFile[]
  top?: string // omitted -> yosys -auto-top
  tool?: SynthTool // omitted -> browser-local Yosys
  mode: Mode
  target?: string // concrete installed part, required for local Vivado
  vivado_family?: string
  vivado_speed?: string
  vivado_version?: string // cache identity from the local connector preflight
  extra_args?: string // platform-specific synthesis-pass flags; safe whitespace-separated tokens
}

export interface VivadoPart {
  name: string
  family: string
  speed: string
}

export interface VivadoBridgeStatus {
  protocol_version: number
  bridge_version: string
  vivado_version: string
  parts: VivadoPart[]
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
  // rough pre-place-and-route worst-case combinational delay (logic +
  // fanout-estimated routing), NOT timing closure. Absent when the design has
  // no combinational paths, for RTL, or for a generic gates/LUT design before
  // the user selects a real process/fabric profile.
  estimated_delay_ns?: number
  estimated_delay_breakdown?: DelayBreakdown
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

// --- Browser-local timing analysis ---

export interface GateDelays {
  and?: number
  or?: number
  xor?: number
  nand?: number
  nor?: number
  xnor?: number
  mux?: number
  not?: number
}

// Delay coefficients (picoseconds) — mirrors the server DelayModel. gate_ps is
// present only for standard-cell profiles; its absence preserves the legacy
// eight-field FPGA/generic shape.
export interface DelayModel {
  lut_ps: number
  carry_ps: number
  wide_mux_ps: number
  cell_ps: number
  ff_clk_to_q_ps: number
  ff_setup_ps: number
  net_base_ps: number
  net_per_fanout_ps: number
  gate_ps?: GateDelays
}

export type DelayProfile =
  | 'series7'
  | 'ultrascale'
  | 'ultrascale_plus'
  | 'ice40'
  | 'ecp5'
  | 'sky130hd'
  | 'gf180mcu'
  | 'asap7'
  | 'generic'

export type SpeedGrade = '-1' | '-2' | '-3' | 'hx' | 'lp'

// Critical-path delay split; the four terms sum to estimated_delay_ns.
export interface DelayBreakdown {
  launch_ns: number
  logic_ns: number
  net_ns: number
  setup_ns: number
}

export interface TimingRequest {
  profile?: DelayProfile // omitted -> the design's synth-time model
  speed_grade?: SpeedGrade // omitted -> the profile's baseline grade
  model?: DelayModel // full override; wins over profile
}

export interface TimingResponse {
  estimated_delay_ns: number | null // also null when this mode/profile is notional
  estimated_delay_breakdown?: DelayBreakdown
  model: DelayModel // base coefficients used (pre speed-grade)
}

export interface VivadoTimingReport {
  data_path_delay_ns: number
  logic_delay_ns?: number
  net_delay_ns?: number
  logic_levels?: number
  slack_ns?: number
  requirement_ns?: number
  startpoint: string
  endpoint: string
  path_group?: string
  corner?: string
  delay_type?: string
  report: string
}

export interface SynthesizeResponse {
  design_id: string // content hash; identical input returns the same id
  top: string // resolved top module
  tool: SynthTool
  mode: string
  delay_profile: DelayProfile // resolved per-design timing family
  target?: string
  stats: Stats
  warnings: string[]
  log: string // yosys log (tail, capped)
  vivado_timing?: VivadoTimingReport
  // true when a generic mode hit the sandbox memory limit and succeeded on a
  // retry that keeps inferred memories abstract ($mem_v2) instead of gates
  memories_abstracted?: boolean
}

// --- Endpoint analysis ---

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

export interface BoundaryEndpoint {
  name: string // boundary-cell display name
  node_id: number
  cell_type: string // memory, vendor primitive, or black-box cell type
  port: string // connected data input pin, e.g. ADDR, WDATA, WE
  width: number
  src?: string
  worst_depth: number
  bits: EndpointBit[]
  bits_truncated: boolean
}

export interface EndpointsResponse {
  registers: RegisterEndpoint[]
  outputs: OutputEndpoint[]
  inputs: InputEndpoint[]
  boundaries: BoundaryEndpoint[]
  boundaries_truncated: boolean
}

// --- Path analysis ---

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
  estimated_delay_ns?: number // rough per-path delay (same model as overview)
}

export interface PathsResponse {
  paths: TimingPath[]
  comb_loops: string[] // names of nodes excluded due to comb cycles
  truncated: boolean // explicit response limit or bounded route-analysis work was hit
}

// --- Fanout analysis ---

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

// --- Node metadata ---
// Resolve node ids to display metadata. Returned in request order; unknown
// ids omitted. At most 200 ids per request (422 above that).

export interface NodesResponse {
  nodes: NodeRef[]
}

// --- Source mapping ---

export interface SourceRangeMapping {
  file: string
  start_line: number
  end_line: number
  start_column?: number
  end_column?: number
  node_ids: number[]
  signalBits?: number[]
  approximateSignalBits?: number[]
  mapping_incomplete: boolean
}

export interface SourceMapResponse {
  files: string[] // filenames as submitted
  by_line: Record<string, number[]> // "file.sv:12" -> node ids
  ranges: SourceRangeMapping[]
  truncated: boolean
}

// --- Bundled examples ---

export type ExampleLanguage = 'verilog' | 'vhdl'

export interface ExampleVariant {
  top: string
  files: DesignFile[]
}

export interface Example {
  name: string // "adder_chain"
  title: string
  description: string
  variants: Record<ExampleLanguage, ExampleVariant>
}

export interface ExamplesResponse {
  examples: Example[]
}

// --- Errors ---

export interface ApiError {
  error: string
  log?: string
}
