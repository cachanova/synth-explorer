use crate::graph::NodeId;
use crate::netlist::PortDirection;
use deepsize::DeepSizeOf;
use serde::Serialize;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, DeepSizeOf)]
#[serde(rename_all = "lowercase")]
pub enum ApiNodeKind {
    Cell,
    Port,
    Const,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct NodeRef {
    pub id: u32,
    pub kind: ApiNodeKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port_direction: Option<PortDirection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub register: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    #[serde(flatten)]
    pub node: NodeRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_root: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_boundary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub controls: Vec<ControlRef>,
    /// Number of projected graph members collapsed into this node; present on
    /// groups enabled by `group_vectors` or `group_memories`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Total members in the canonical group. This can exceed `width` when a
    /// bounded projection carries only a representative subset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_count: Option<u32>,
    /// Real graph node ids collapsed into this group. These are the physical
    /// ids `/nodes` still addresses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<u32>>,
    /// Ordered physical members of a grouped top-level port. `bit` is the
    /// member's declared port slot, not a Yosys net id. Omitted for scalar
    /// ports and non-boundary groups.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub boundary_members: Vec<BoundaryMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct BoundaryMember {
    pub member: u32,
    pub bit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EdgeBoundaryMember {
    pub member: u32,
    pub net_bits: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlRole {
    Clock,
    Reset,
    Set,
    Enable,
    Other,
}

#[derive(Debug, Clone, Serialize)]
pub struct ControlRef {
    pub role: ControlRole,
    pub pin: String,
    pub net_name: String,
    pub driver_id: NodeId,
    /// Distinct drivers represented by a compact grouped-control row. Empty
    /// for an ordinary single control.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub driver_ids: Vec<NodeId>,
    /// Number of distinct control nets represented by this row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_count: Option<u32>,
    pub fanout: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_low: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synchronous: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from: u32,
    pub to: u32,
    pub from_port: String,
    pub to_port: String,
    pub net_name: String,
    pub bits: Vec<u32>,
    /// Labeled global-control semantics for filtering and presentation. A
    /// logic-generated enable remains ordinary dataflow even though it lands
    /// on a physical register enable pin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<bool>,
    /// Physical grouped-boundary sources that contributed to this quotient
    /// edge, with their exact Yosys net bits.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub source_boundary_members: Vec<EdgeBoundaryMember>,
    /// Physical grouped-boundary targets that contributed to this quotient
    /// edge, with their exact Yosys net bits.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub target_boundary_members: Vec<EdgeBoundaryMember>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Subgraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

/// One canonical group rendered as its physical instances plus their immediate
/// connections. `members` names exactly the raw nodes enclosed by the UI's
/// expanded-group boundary; neighboring nodes are context only.
#[derive(Debug, Clone, Serialize)]
pub struct GroupExpansion {
    pub graph: Subgraph,
    pub members: Vec<NodeId>,
    /// Exact compact quotient trunks replaced by expanded member edges.
    /// Consumers use exact projected-key equality; they must not guess from
    /// net labels, coincident endpoints, or array order.
    pub boundary_trunks: Vec<GroupExpansionBoundaryTrunk>,
}

/// Exact identity used when analysis merges raw edges into one projected edge.
/// This deliberately excludes raw-edge occurrence order and payload fields
/// such as net labels and bits.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub struct ProjectedEdgeKey {
    pub from: NodeId,
    pub to: NodeId,
    pub from_port: String,
    pub to_port: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GroupExpansionBoundaryTrunk {
    pub compact_edge: ProjectedEdgeKey,
    pub expanded_edges: Vec<ProjectedEdgeKey>,
}

#[derive(Debug, Clone, Copy)]
pub struct GroupExpansionOptions {
    pub max_nodes: usize,
    pub hide_control: bool,
    pub hide_const: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct SourceSelectionOptions {
    pub max_nodes: usize,
    pub hide_control: bool,
    pub hide_const: bool,
    pub group_vectors: bool,
    pub group_memories: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceSelectionStatus {
    Mapped,
    MappingIncomplete,
    OptimizedOrAbsorbed,
    Unmapped,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceSelectionResult {
    pub status: SourceSelectionStatus,
    pub control: bool,
    #[serde(rename = "directIds")]
    pub direct_ids: Vec<u32>,
    /// Final Yosys net-bit ids directly named by the selected declaration.
    /// Bit identity survives edge merging and vector grouping, unlike edge ids.
    #[serde(rename = "directBits")]
    pub direct_bits: Vec<u32>,
    pub graph: Subgraph,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SourceSelectionError {
    #[error("unknown file")]
    UnknownFile,
    #[error("line range must satisfy 1 <= start_line <= end_line")]
    InvalidRange,
    #[error("at most 200 source lines may be selected")]
    TooManyLines,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct EndpointBit {
    pub bit: usize,
    pub node_id: u32,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct InputBit {
    pub bit: usize,
    pub node_id: u32,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct RegisterGroup {
    pub name: String,
    pub width: usize,
    pub cell_type: String,
    pub clock: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    pub worst_depth: u32,
    pub bits: Vec<EndpointBit>,
    pub output_aliases: Vec<OutputAlias>,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct OutputAliasBit {
    pub output_bit: usize,
    pub register_bit: usize,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct OutputAlias {
    pub name: String,
    pub width: usize,
    pub bits: Vec<OutputAliasBit>,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct OutputGroup {
    pub name: String,
    pub width: usize,
    pub worst_depth: u32,
    pub bits: Vec<EndpointBit>,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct InputGroup {
    pub name: String,
    pub width: usize,
    pub bits: Vec<InputBit>,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct BoundaryEndpoint {
    pub name: String,
    pub node_id: NodeId,
    pub cell_type: String,
    pub port: String,
    pub width: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    pub worst_depth: u32,
    pub bits: Vec<EndpointBit>,
    pub bits_truncated: bool,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct EndpointsResponse {
    pub registers: Vec<RegisterGroup>,
    pub outputs: Vec<OutputGroup>,
    pub inputs: Vec<InputGroup>,
    pub boundaries: Vec<BoundaryEndpoint>,
    pub boundaries_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PathEntry {
    pub depth: u32,
    pub class: PathClass,
    pub endpoint_group: String,
    pub endpoint_kind: EndpointKind,
    pub bits: Vec<usize>,
    pub output_aliases: Vec<OutputAlias>,
    pub startpoint: NodeRef,
    pub endpoint: NodeRef,
    pub endpoint_port: String,
    pub nodes: Vec<NodeRef>,
    /// Rough estimated delay along this path (ns), from the same model as the
    /// overview estimate. `None` if the path could not be delay-costed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_delay_ns: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, DeepSizeOf)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKind {
    Register,
    Output,
    Blackbox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, DeepSizeOf)]
#[serde(rename_all = "snake_case")]
pub enum PathClass {
    InputToRegister,
    RegisterToRegister,
    RegisterToOutput,
    InputToOutput,
    Other,
}

#[derive(Debug, Clone, Serialize)]
pub struct PathsResponse {
    pub paths: Vec<PathEntry>,
    pub comb_loops: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PathSort {
    #[default]
    Depth,
    Delay,
}

#[derive(Debug, Clone, Serialize)]
pub struct FanoutDriver {
    pub driver: NodeRef,
    pub port: String,
    pub net_name: String,
    pub fanout: usize,
    pub endpoints: usize,
    pub control: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FanoutResponse {
    pub drivers: Vec<FanoutDriver>,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct Stats {
    pub num_cells: usize,
    pub cells_by_type: BTreeMap<String, usize>,
    pub num_register_bits: usize,
    pub num_register_groups: usize,
    pub num_inputs: usize,
    pub num_outputs: usize,
    pub max_depth: u32,
    pub depths: DepthSummary,
    pub cell_categories: CellCategoryCounts,
    /// Rough estimated worst-case combinational delay in nanoseconds — a
    /// pre-place-and-route figure (logic + fanout-estimated routing), NOT timing
    /// closure. `None` when the design has no combinational paths.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_delay_ns: Option<f64>,
    /// How `estimated_delay_ns` splits across the critical path (ns). The four
    /// terms sum to `estimated_delay_ns`. `None` when there is no estimate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_delay_breakdown: Option<DelayBreakdown>,
}

/// The estimated critical-path delay split into contributions (nanoseconds).
/// `launch_ns + logic_ns + net_ns + setup_ns == estimated_delay_ns`.
#[derive(Debug, Clone, Copy, Serialize, DeepSizeOf)]
pub struct DelayBreakdown {
    pub launch_ns: f64,
    pub logic_ns: f64,
    pub net_ns: f64,
    pub setup_ns: f64,
}

#[derive(Debug, Clone, Default, Serialize, DeepSizeOf)]
pub struct DepthSummary {
    pub input_to_register: Option<u32>,
    pub register_to_register: Option<u32>,
    pub register_to_output: Option<u32>,
    pub input_to_output: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, DeepSizeOf)]
pub struct CellCategoryCounts {
    pub logic: usize,
    pub registers: usize,
    pub carry_special: usize,
    pub infrastructure: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConeDir {
    Fanin,
    Fanout,
}

#[derive(Debug, Clone, Copy)]
pub struct ConeOptions<'a> {
    pub dir: ConeDir,
    pub max_depth: u32,
    pub max_nodes: usize,
    pub hide_control: bool,
    pub hide_const: bool,
    pub show_infrastructure: bool,
    /// Restrict the first hop of a single-root cone to one physical cell pin.
    pub root_port: Option<&'a str>,
    /// Further restrict `root_port` to one bit when the endpoint is expanded.
    pub root_port_bit: Option<u32>,
    /// Restrict `root_port` to the bit cohort represented by a grouped path.
    pub root_port_bits: Option<&'a [u32]>,
}

#[derive(Debug, Clone, Copy)]
pub struct FullNetlistOptions<'a> {
    pub max_nodes: usize,
    pub show_infrastructure: bool,
    pub hide_control: bool,
    pub hide_const: bool,
    pub priority_roots: &'a [NodeId],
}

impl ConeDir {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "fanin" => Some(Self::Fanin),
            "fanout" => Some(Self::Fanout),
            _ => None,
        }
    }
}
/// The estimated worst-case delay and its breakdown for a design under `model`.
pub struct TimingEstimate {
    pub delay_ns: Option<f64>,
    pub breakdown: Option<DelayBreakdown>,
    pub starts_at_register: Option<bool>,
    pub endpoint_kind: Option<EndpointKind>,
}
