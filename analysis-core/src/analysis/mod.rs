//! Bounded structural analysis and API response projections.

use crate::delay_model::DelayModel;
use crate::graph::{
    Edge, Graph, NodeId, NodeKind, cell_depth_weight, is_addressable_sequential_type,
    is_infrastructure_cell, is_latch_type, is_register_type, is_transparent_data_buffer,
    strip_bit_suffix,
};
use crate::grouping::{GroupId, GroupKind, GroupPartition, GroupingProjection};
use crate::netlist::PortDirection;
use crate::source::coordinates::parse_src_loc;
use crate::source::{
    SourceBitRangesResponse, SourceMapResponse, SourceProbeDirection, SourceProvenanceIndex,
    SourceSelectionRange,
};
#[cfg(test)]
use crate::source::{SourceProbeHint, SourceRangeMapping};
use deepsize::DeepSizeOf;
use serde::Serialize;
use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use thiserror::Error;

const PATH_NODE_CAP: usize = 512;
const PATH_RECONSTRUCTION_NODE_BUDGET: usize = 65_536;
pub const MAX_PATH_RESULTS: usize = 8_000;
pub const MAX_SUBGRAPH_NODES: usize = 2_000;
/// A deliberate group expansion can be wider than an ordinary cone. This
/// accommodates the 2,048-instance inferred-memory regression plus context.
pub const MAX_GROUP_EXPANSION_NODES: usize = 4_096;
const MAX_FULL_GROUP_MEMBERS: usize = 256;
pub const MAX_SUBGRAPH_EDGES: usize = 10_000;
const MAX_SUBGRAPH_EDGE_BITS: usize = MAX_SUBGRAPH_EDGES;
const MAX_FULL_NETLIST_EDGE_VISITS: usize = MAX_SUBGRAPH_EDGES * 4;
const MAX_GROUP_EXPANSION_EDGE_VISITS: usize = MAX_SUBGRAPH_EDGES * 4;
const MAX_BOUNDARY_ENDPOINTS: usize = 10_000;
const MAX_BOUNDARY_ENDPOINT_BITS: usize = 100_000;
const FULL_NETLIST_CONTEXT_NODE_BUDGET: usize = MAX_SUBGRAPH_NODES * 16;
const _: () = assert!(crate::source::SOURCE_ROOT_COLLECTION_CAP == MAX_SUBGRAPH_NODES + 1);
const SOURCE_BIDIRECTIONAL_DEPTH: u32 = 1;

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

#[derive(Debug, Clone, Default)]
struct BoundaryElectricalProvenance {
    source_bits: Option<Vec<u32>>,
    target_bits: Option<Vec<u32>>,
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

/// Private projection state whose provenance entries are index-aligned with
/// `subgraph.edges`. Public ungrouped responses discard the sidecar unchanged;
/// grouped quotient projection consumes it before returning a `Subgraph`.
#[derive(Debug, Clone)]
struct ProjectedSubgraph {
    subgraph: Subgraph,
    boundary_electrical: Vec<Option<Box<BoundaryElectricalProvenance>>>,
}

impl ProjectedSubgraph {
    fn new(
        subgraph: Subgraph,
        boundary_electrical: Vec<Option<Box<BoundaryElectricalProvenance>>>,
    ) -> Self {
        assert_eq!(
            subgraph.edges.len(),
            boundary_electrical.len(),
            "every projected edge must have one provenance sidecar slot"
        );
        Self {
            subgraph,
            boundary_electrical,
        }
    }

    fn into_public(self) -> Subgraph {
        self.subgraph
    }
}

impl From<Subgraph> for ProjectedSubgraph {
    fn from(subgraph: Subgraph) -> Self {
        let boundary_electrical = (0..subgraph.edges.len()).map(|_| None).collect();
        Self::new(subgraph, boundary_electrical)
    }
}

impl std::ops::Deref for ProjectedSubgraph {
    type Target = Subgraph;

    fn deref(&self) -> &Self::Target {
        &self.subgraph
    }
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

/// Picosecond accumulator used while walking the delay-critical path.
#[derive(Debug, Clone, Copy, Default)]
struct DelayBreakdownPs {
    launch: f64,
    logic: f64,
    net: f64,
    setup: f64,
}

impl DelayBreakdown {
    fn from_ps(ps: DelayBreakdownPs) -> Self {
        Self {
            launch_ns: ps.launch / 1000.0,
            logic_ns: ps.logic / 1000.0,
            net_ns: ps.net / 1000.0,
            setup_ns: ps.setup / 1000.0,
        }
    }
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

struct DepthComputation {
    node_depth: Vec<Option<u32>>,
    best_pred: Vec<Option<usize>>,
    delay_pred: Vec<Option<usize>>,
    node_startpoint: Vec<Option<NodeId>>,
    delay_startpoint: Vec<Option<NodeId>>,
    /// Estimated worst-case combinational delay (picoseconds) over all paths —
    /// a rough pre-place-and-route figure from the fanout-aware delay model.
    estimated_max_delay_ps: Option<f64>,
    /// The critical path's delay split into launch/logic/net/setup (picoseconds).
    estimated_max_delay_breakdown: Option<DelayBreakdownPs>,
    /// Domain of the same delay-critical path. Kept with the overview result so
    /// callers do not have to infer it from the bounded, depth-sorted path list.
    estimated_max_delay_starts_at_register: Option<bool>,
    estimated_max_delay_endpoint_kind: Option<EndpointKind>,
    /// Per-node arrival time (picoseconds) at each comb node's output, for
    /// reconstructing a specific path's estimated delay.
    node_delay: Vec<f64>,
    /// Arrival following the structural predecessor, for costing depth paths.
    depth_path_delay: Vec<f64>,
}

#[derive(Debug, Clone, DeepSizeOf)]
pub struct Analysis {
    node_depth: Vec<Option<u32>>,
    node_delay: Vec<f64>,
    depth_path_delay: Vec<f64>,
    best_pred: Vec<Option<usize>>,
    delay_pred: Vec<Option<usize>>,
    delay_startpoint: Vec<Option<NodeId>>,
    comb_loops: Vec<NodeId>,
    comb_loop_set: HashSet<NodeId>,
    endpoints: EndpointsResponse,
    endpoint_targets: Vec<EndpointTarget>,
    endpoint_targets_truncated: bool,
    source_provenance: SourceProvenanceIndex,
    has_control_output: Vec<bool>,
    pure_hidden_control_ports: HashSet<NodeId>,
    stats: Stats,
    warnings: Vec<String>,
    /// The delay model used for the estimated timing figures (from the target).
    delay_model: DelayModel,
}

#[derive(Debug, Clone, DeepSizeOf)]
struct EndpointTarget {
    endpoint: NodeId,
    endpoint_port: String,
    edge: Option<usize>,
    startpoint: NodeId,
    depth: u32,
    group: String,
    kind: EndpointKind,
    bit: usize,
}

#[derive(Clone, Copy)]
struct PathComputation<'a> {
    model: &'a DelayModel,
    sort: PathSort,
    node_delay: &'a [f64],
    depth_path_delay: &'a [f64],
    delay_pred: &'a [Option<usize>],
    delay_startpoint: &'a [Option<NodeId>],
}

struct PathSelection {
    response: PathsResponse,
    reconstructed_nodes: usize,
}

type PathGroupKey = (String, EndpointKind, PathClass, u32, String, Vec<String>);
type EndpointTargetGroupKey<'a> = (EndpointKind, &'a str, &'a str);
type EndpointTargetGroup<'a> = (EndpointTargetGroupKey<'a>, Vec<&'a EndpointTarget>);

impl Analysis {
    pub fn new(graph: &Graph, source_files: Vec<String>) -> Self {
        Self::with_delay_model(graph, source_files, &DelayModel::default())
    }

    /// Like [`Analysis::new`], but uses a specific delay model for the estimated
    /// timing figure (e.g. one selected from the synthesis target).
    pub fn with_delay_model(graph: &Graph, source_files: Vec<String>, model: &DelayModel) -> Self {
        let source_provenance = SourceProvenanceIndex::from_graph(graph, source_files.clone());
        Self::with_delay_model_and_source_provenance(graph, source_files, model, source_provenance)
    }

    pub(crate) fn with_delay_model_and_source_provenance(
        graph: &Graph,
        source_files: Vec<String>,
        model: &DelayModel,
        source_provenance: SourceProvenanceIndex,
    ) -> Self {
        let comb_loops = find_comb_loops(graph);
        let loop_set: HashSet<NodeId> = comb_loops.iter().copied().collect();
        let DepthComputation {
            node_depth,
            best_pred,
            delay_pred,
            node_startpoint,
            delay_startpoint,
            estimated_max_delay_ps,
            estimated_max_delay_breakdown,
            node_delay,
            depth_path_delay,
            ..
        } = compute_depths(graph, &loop_set, model);
        let (endpoints, endpoint_targets, endpoint_targets_truncated) =
            discover_endpoints(graph, &node_depth, &node_startpoint, &source_files);
        let stats = build_stats(
            graph,
            &endpoints,
            &endpoint_targets,
            &node_depth,
            estimated_max_delay_ps,
            estimated_max_delay_breakdown,
        );
        let warnings = build_warnings(graph, &comb_loops);
        let has_control_output = graph
            .outgoing
            .iter()
            .map(|edges| edges.iter().any(|edge| graph.edges[*edge].control))
            .collect();
        let pure_hidden_control_ports = pure_hidden_control_ports(graph);
        Self {
            node_depth,
            node_delay,
            depth_path_delay,
            best_pred,
            delay_pred,
            delay_startpoint,
            comb_loops,
            comb_loop_set: loop_set,
            endpoints,
            endpoint_targets,
            endpoint_targets_truncated,
            source_provenance,
            has_control_output,
            pure_hidden_control_ports,
            stats,
            warnings,
            delay_model: *model,
        }
    }

    pub fn endpoints(&self) -> &EndpointsResponse {
        &self.endpoints
    }

    pub fn comb_loops(&self) -> &[NodeId] {
        &self.comb_loops
    }

    pub fn stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }

    pub fn source_map(&self) -> SourceMapResponse {
        self.source_provenance.source_map()
    }

    pub fn source_ranges_for_bits(&self, bits: &[u32]) -> SourceBitRangesResponse {
        self.source_provenance.source_ranges_for_bits(bits)
    }

    pub fn source_selection(
        &self,
        graph: &Graph,
        grouping: &GroupPartition,
        selection: SourceSelectionRange<'_>,
        options: SourceSelectionOptions,
    ) -> Result<SourceSelectionResult, SourceSelectionError> {
        self.source_selection_with_fallback(graph, grouping, selection, None, options)
    }

    pub fn source_selection_with_fallback(
        &self,
        graph: &Graph,
        grouping: &GroupPartition,
        selection: SourceSelectionRange<'_>,
        fallback_columns: Option<(usize, usize)>,
        options: SourceSelectionOptions,
    ) -> Result<SourceSelectionResult, SourceSelectionError> {
        if !self.source_provenance.contains_file(selection.file) {
            return Err(SourceSelectionError::UnknownFile);
        }
        let SourceSelectionRange {
            start_line,
            end_line,
            start_column,
            end_column,
            ..
        } = selection;
        if start_line < 1
            || end_line < start_line
            || start_column.zip(end_column).is_some_and(|(start, end)| {
                start < 1 || end < 1 || (start_line == end_line && end < start)
            })
            || start_column.is_some() != end_column.is_some()
        {
            return Err(SourceSelectionError::InvalidRange);
        }
        if end_line - start_line >= 200 {
            return Err(SourceSelectionError::TooManyLines);
        }
        let probe = self
            .source_provenance
            .resolve_selection(selection, fallback_columns)
            .ok_or(SourceSelectionError::UnknownFile)?;
        let control = probe
            .roots
            .iter()
            .any(|root| self.has_control_output[*root as usize]);
        let cone_options = ConeOptions {
            dir: match probe.direction {
                Some(SourceProbeDirection::Fanout) => ConeDir::Fanout,
                _ => ConeDir::Fanin,
            },
            // An unqualified signal declaration has useful logic on both sides,
            // but traversing the full connected component makes Focus a no-op.
            max_depth: if probe.local_bidirectional {
                SOURCE_BIDIRECTIONAL_DEPTH
            } else {
                64
            },
            max_nodes: options.max_nodes,
            hide_control: options.hide_control && !control,
            hide_const: options.hide_const,
            show_infrastructure: false,
            root_port: None,
            root_port_bit: None,
            root_port_bits: None,
        };
        let selected_grouping =
            GroupingProjection::from_flags(grouping, options.group_vectors, options.group_memories);
        let mut graph = match probe.direction {
            Some(_) => self.multi_root_source_cone(
                graph,
                &probe.roots,
                cone_options,
                selected_grouping,
                probe.expand_output_register_inputs,
            ),
            None => self.multi_root_source_envelope(
                graph,
                &probe.roots,
                cone_options,
                selected_grouping,
            ),
        }
        .expect("source indexes contain only valid graph node ids");
        graph.truncated |= probe.truncated;
        let direct_ids = graph
            .nodes
            .iter()
            .filter(|node| node.is_root == Some(true))
            .map(|node| node.node.id)
            .collect();
        let status = if probe.mapping_incomplete {
            SourceSelectionStatus::MappingIncomplete
        } else if !probe.roots.is_empty() {
            SourceSelectionStatus::Mapped
        } else if probe.source_seen {
            SourceSelectionStatus::OptimizedOrAbsorbed
        } else {
            SourceSelectionStatus::Unmapped
        };
        Ok(SourceSelectionResult {
            status,
            control,
            direct_ids,
            direct_bits: probe.direct_bits,
            graph,
        })
    }

    pub fn node_ref(&self, graph: &Graph, id: NodeId) -> NodeRef {
        let mut reference = node_ref(graph, id);
        let recovered = self.source_provenance.recovered_sources_for_node(id);
        if recovered.is_empty() {
            return reference;
        }
        let mut sources: BTreeSet<String> = reference
            .src
            .as_deref()
            .into_iter()
            .flat_map(|src| src.split('|'))
            .map(str::to_owned)
            .collect();
        sources.extend(recovered);
        reference.src =
            (!sources.is_empty()).then(|| sources.into_iter().collect::<Vec<_>>().join("|"));
        reference
    }

    pub fn estimated_source_provenance_heap_bytes(&self) -> usize {
        self.source_provenance.estimated_heap_bytes()
    }

    #[cfg(test)]
    fn extend_source_ranges(&mut self, ranges: Vec<SourceRangeMapping>, truncated: bool) {
        self.source_provenance.extend_test_ranges(ranges, truncated);
    }

    #[cfg(test)]
    fn set_source_probe_hints(&mut self, hints: Vec<SourceProbeHint>) {
        self.source_provenance.set_test_hints(hints);
    }

    #[cfg(test)]
    fn set_procedural_targets(&mut self, targets: HashMap<(String, usize), Vec<NodeId>>) {
        self.source_provenance.set_test_procedural_targets(targets);
    }

    /// Structural route variants selected by both depth and delay, with
    /// `sort` affecting presentation order only. The union stays bounded by
    /// `limit` and reports truncation when either selection or the union is
    /// clipped.
    pub fn path_variants_with_model(
        &self,
        graph: &Graph,
        model: &DelayModel,
        limit: usize,
        to: Option<NodeId>,
        sort: PathSort,
    ) -> PathsResponse {
        self.path_variants_with_model_and_work(graph, model, limit, to, sort)
            .0
    }

    fn path_variants_with_model_and_work(
        &self,
        graph: &Graph,
        model: &DelayModel,
        limit: usize,
        to: Option<NodeId>,
        sort: PathSort,
    ) -> (PathsResponse, usize) {
        let recomputed;
        let (node_delay, depth_path_delay, delay_pred, delay_startpoint) =
            if *model == self.delay_model {
                (
                    &self.node_delay,
                    &self.depth_path_delay,
                    &self.delay_pred,
                    &self.delay_startpoint,
                )
            } else {
                recomputed = compute_depths(graph, &self.comb_loop_set, model);
                (
                    &recomputed.node_delay,
                    &recomputed.depth_path_delay,
                    &recomputed.delay_pred,
                    &recomputed.delay_startpoint,
                )
            };
        let depth_computation = PathComputation {
            model,
            sort: PathSort::Depth,
            node_delay,
            depth_path_delay,
            delay_pred,
            delay_startpoint,
        };
        let delay_computation = PathComputation {
            sort: PathSort::Delay,
            ..depth_computation
        };
        let depth_budget = PATH_RECONSTRUCTION_NODE_BUDGET / 2;
        let delay_budget = PATH_RECONSTRUCTION_NODE_BUDGET - depth_budget;
        let depth_selection =
            self.paths_with_computation(graph, limit, to, &depth_computation, depth_budget);
        let delay_selection =
            self.paths_with_computation(graph, limit, to, &delay_computation, delay_budget);
        let reconstructed_nodes =
            depth_selection.reconstructed_nodes + delay_selection.reconstructed_nodes;
        debug_assert!(reconstructed_nodes <= PATH_RECONSTRUCTION_NODE_BUDGET);
        let depth = depth_selection.response;
        let delay = delay_selection.response;
        debug_assert_eq!(depth.comb_loops, delay.comb_loops);
        let mut truncated = depth.truncated || delay.truncated;
        let comb_loops = depth.comb_loops;
        let mut grouped: BTreeMap<_, PathEntry> = BTreeMap::new();

        for path in depth.paths.into_iter().chain(delay.paths) {
            let signature = path.nodes.iter().map(|node| node.id).collect::<Vec<_>>();
            let key = (
                path.endpoint_group.clone(),
                path.endpoint_kind,
                path.class,
                path.depth,
                path.endpoint_port.clone(),
                signature,
            );
            if let Some(existing) = grouped.get_mut(&key) {
                existing.bits.extend(path.bits);
                existing.bits.sort_unstable();
                existing.bits.dedup();
                merge_output_aliases(&mut existing.output_aliases, path.output_aliases);
            } else {
                grouped.insert(key, path);
            }
        }

        let mut paths: Vec<PathEntry> = grouped.into_values().collect();
        paths.sort_by(compare_path_membership);
        if paths.len() > limit {
            paths.truncate(limit);
            truncated = true;
        }
        paths.sort_by(|a, b| compare_path_entries(a, b, sort));
        (
            PathsResponse {
                paths,
                comb_loops,
                truncated,
            },
            reconstructed_nodes,
        )
    }

    /// Return structural paths delay-costed with a caller-supplied model (e.g. a
    /// client's retune), so per-path delays track the overview.
    pub fn paths_with_model(
        &self,
        graph: &Graph,
        model: &DelayModel,
        limit: usize,
        to: Option<NodeId>,
        sort: PathSort,
    ) -> PathsResponse {
        // Path structure (targets, routes) is model-independent; only the delay
        // numbers depend on the model. Reuse the synth-time arrivals when the
        // caller's model matches, else recompute the delay DP for it.
        let recomputed;
        let computation = if *model == self.delay_model {
            PathComputation {
                model,
                sort,
                node_delay: &self.node_delay,
                depth_path_delay: &self.depth_path_delay,
                delay_pred: &self.delay_pred,
                delay_startpoint: &self.delay_startpoint,
            }
        } else {
            recomputed = compute_depths(graph, &self.comb_loop_set, model);
            PathComputation {
                model,
                sort,
                node_delay: &recomputed.node_delay,
                depth_path_delay: &recomputed.depth_path_delay,
                delay_pred: &recomputed.delay_pred,
                delay_startpoint: &recomputed.delay_startpoint,
            }
        };
        self.paths_with_computation(
            graph,
            limit,
            to,
            &computation,
            PATH_RECONSTRUCTION_NODE_BUDGET,
        )
        .response
    }

    fn paths_with_computation(
        &self,
        graph: &Graph,
        limit: usize,
        to: Option<NodeId>,
        computation: &PathComputation<'_>,
        reconstruction_node_budget: usize,
    ) -> PathSelection {
        let sort = computation.sort;
        let target_delay = |target: &EndpointTarget| {
            self.path_delay_ns(graph, target, computation.node_delay, computation.model)
                .unwrap_or(f64::NEG_INFINITY)
        };
        let compare_rank = |a: &EndpointTarget, b: &EndpointTarget| match sort {
            PathSort::Depth => compare_target_rank(a, b),
            PathSort::Delay => target_delay(b)
                .total_cmp(&target_delay(a))
                .then_with(|| compare_target_rank(a, b)),
        };
        const TARGETS_PER_GROUP_CAP: usize = 64;
        let candidate_cap = limit.max(1).saturating_mul(16).min(MAX_PATH_RESULTS);
        let mut total_targets = 0;
        let mut grouped_targets: HashMap<EndpointTargetGroupKey<'_>, Vec<&EndpointTarget>> =
            HashMap::new();
        for target in self
            .endpoint_targets
            .iter()
            .filter(|target| to.is_none_or(|id| target.endpoint == id))
        {
            total_targets += 1;
            let group = grouped_targets
                .entry((
                    target.kind,
                    target.group.as_str(),
                    target.endpoint_port.as_str(),
                ))
                .or_default();
            if group.len() < TARGETS_PER_GROUP_CAP {
                group.push(target);
                continue;
            }
            let worst = group
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| compare_rank(a, b))
                .map(|(index, _)| index)
                .expect("a capped target group is not empty");
            if compare_rank(target, group[worst]) == Ordering::Less {
                group[worst] = target;
            }
        }

        let mut target_groups: Vec<EndpointTargetGroup<'_>> = grouped_targets.into_iter().collect();
        for (_, targets) in &mut target_groups {
            targets.sort_by(|a, b| compare_rank(a, b));
        }
        target_groups.sort_by(|(a_key, a), (b_key, b)| {
            compare_rank(a[0], b[0]).then_with(|| a_key.cmp(b_key))
        });

        // Give every top-ranked logical endpoint a representative before spending
        // the bounded budget on additional bit/route variants. Extra targets
        // are selected round-robin so a single wide vector cannot crowd out
        // other groups.
        let represented_groups = target_groups.len().min(candidate_cap);
        let mut candidates = Vec::with_capacity(candidate_cap);
        for (_, targets) in target_groups.iter().take(represented_groups) {
            candidates.push(targets[0]);
        }
        let mut bit_index = 1;
        while candidates.len() < candidate_cap {
            let mut added = false;
            for (_, targets) in target_groups.iter().take(represented_groups) {
                let Some(target) = targets.get(bit_index) else {
                    continue;
                };
                candidates.push(*target);
                added = true;
                if candidates.len() == candidate_cap {
                    break;
                }
            }
            if !added {
                break;
            }
            bit_index += 1;
        }

        let candidate_alias_keys: HashSet<(&str, usize)> = candidates
            .iter()
            .filter(|target| target.kind == EndpointKind::Register)
            .map(|target| (target.group.as_str(), target.bit))
            .collect();
        let alias_lookup = build_alias_lookup(&self.endpoints, &candidate_alias_keys);
        let mut grouped: BTreeMap<PathGroupKey, PathEntry> = BTreeMap::new();
        let mut route_clipped = false;
        let mut reconstruction_budget = reconstruction_node_budget;
        let mut reconstructed_candidates = 0;
        for target in &candidates {
            if reconstruction_budget < 2 {
                route_clipped = true;
                break;
            }
            let per_path_cap = PATH_NODE_CAP.min(reconstruction_budget);
            let (path, clipped, consumed_nodes) =
                self.path_for_target(graph, target, per_path_cap, &alias_lookup, computation);
            reconstruction_budget = reconstruction_budget.saturating_sub(consumed_nodes);
            reconstructed_candidates += 1;
            route_clipped |= clipped;
            let signature = path
                .nodes
                .iter()
                .map(path_node_signature)
                .collect::<Vec<_>>();
            let key = (
                path.endpoint_group.clone(),
                path.endpoint_kind,
                path.class,
                path.depth,
                path.endpoint_port.clone(),
                signature,
            );
            if let Some(existing) = grouped.get_mut(&key) {
                existing.bits.extend(path.bits);
                existing.bits.sort_unstable();
                existing.bits.dedup();
                merge_output_aliases(&mut existing.output_aliases, path.output_aliases);
            } else {
                grouped.insert(key, path);
            }
        }
        let mut paths: Vec<PathEntry> = grouped.into_values().collect();
        paths.sort_by(|a, b| compare_path_entries(a, b, sort));
        let grouped_count = paths.len();
        paths.truncate(limit);
        PathSelection {
            response: PathsResponse {
                paths,
                comb_loops: self
                    .comb_loops
                    .iter()
                    .map(|id| graph.node_ref_name(*id))
                    .collect(),
                truncated: self.endpoint_targets_truncated
                    || route_clipped
                    || reconstructed_candidates < candidates.len()
                    || candidates.len() < total_targets
                    || grouped_count > limit,
            },
            reconstructed_nodes: reconstruction_node_budget - reconstruction_budget,
        }
    }

    /// Retune the worst-case delay using the model-independent loop set found
    /// when this analysis was built.
    pub fn estimate_timing(&self, graph: &Graph, model: &DelayModel) -> TimingEstimate {
        let dc = compute_depths(graph, &self.comb_loop_set, model);
        TimingEstimate {
            delay_ns: dc.estimated_max_delay_ps.map(|ps| ps / 1000.0),
            breakdown: dc
                .estimated_max_delay_breakdown
                .map(DelayBreakdown::from_ps),
            starts_at_register: dc.estimated_max_delay_starts_at_register,
            endpoint_kind: dc.estimated_max_delay_endpoint_kind,
        }
    }

    pub fn multi_root_cone(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[options.dir],
            options,
            grouping,
            SubgraphWorkLimits::for_public_projection(),
        )
    }

    fn multi_root_source_cone(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
        grouping: Option<GroupingProjection<'_>>,
        expand_output_register_inputs: bool,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[options.dir],
            options,
            grouping,
            SubgraphWorkLimits::for_source_selection(expand_output_register_inputs),
        )
    }

    fn multi_root_source_envelope(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[ConeDir::Fanin, ConeDir::Fanout],
            options,
            grouping,
            SubgraphWorkLimits::for_source_selection(false),
        )
    }

    fn multi_root_subgraph(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        directions: &[ConeDir],
        options: ConeOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
        work_limits: SubgraphWorkLimits,
    ) -> Option<Subgraph> {
        if roots
            .iter()
            .any(|root| graph.nodes.get(*root as usize).is_none())
        {
            return None;
        }

        // With grouping the node budget counts distinct group-or-singleton
        // units, not member bits, so a wide bus costs one unit. `seen_units`
        // tracks the paid units; without grouping it mirrors `seen` exactly.
        let base = graph.nodes.len() as u32;
        let cap = options.max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
        let raw_root_cap = work_limits
            .max_raw_nodes
            .unwrap_or(MAX_SUBGRAPH_NODES)
            .saturating_div(2)
            .max(1);
        let (bounded_roots, roots_truncated) =
            bounded_projection_roots(roots, grouping, base, cap, raw_root_cap);
        let mut seen: HashSet<NodeId> = HashSet::new();
        let mut seen_units: HashSet<u32> = HashSet::new();
        let mut unique_roots: HashSet<NodeId> = HashSet::new();
        let mut included_root_ids = Vec::new();
        let mut boundary_nodes: HashSet<NodeId> = HashSet::new();
        let mut edge_set: HashSet<usize> = HashSet::new();
        let mut raw_edges_per_connection: HashMap<(NodeId, NodeId, String, String), usize> =
            HashMap::new();
        let mut expanded_register_inputs: HashSet<NodeId> = HashSet::new();
        let mut examined_edges = 0usize;
        let mut truncated = roots_truncated;

        for root in &bounded_roots {
            if unique_roots.insert(*root) {
                if work_limits
                    .max_raw_nodes
                    .is_some_and(|limit| seen.len() >= limit)
                {
                    truncated = true;
                    continue;
                }
                let unit = unit_id(grouping, base, *root);
                if !seen_units.contains(&unit) && seen_units.len() >= cap {
                    truncated = true;
                    continue;
                }
                seen_units.insert(unit);
                seen.insert(*root);
                included_root_ids.push(*root);
            }
        }

        let included_roots = seen.clone();
        let mut output_register_frontier: HashSet<NodeId> =
            if work_limits.expand_output_register_inputs {
                included_roots
                    .iter()
                    .copied()
                    .filter(|id| {
                        let node = &graph.nodes[*id as usize];
                        (node.kind == NodeKind::PortBit
                            && matches!(
                                node.port_dir,
                                Some(PortDirection::Output | PortDirection::Inout)
                            ))
                            || node
                                .cell_type
                                .as_deref()
                                .is_some_and(is_transparent_data_buffer)
                    })
                    .collect()
            } else {
                HashSet::new()
            };
        let mut traversals: Vec<Traversal> = directions
            .iter()
            .map(|dir| Traversal {
                dir: *dir,
                seen: included_roots.clone(),
                queue: included_root_ids
                    .iter()
                    .copied()
                    .map(|root| TraversalFrame {
                        id: root,
                        depth: 0,
                        next_edge: 0,
                    })
                    .collect(),
            })
            .collect();

        'walk: loop {
            let mut advanced = false;
            for traversal in &mut traversals {
                'frames: while let Some(mut frame) = traversal.queue.pop_front() {
                    if frame.next_edge == 0
                        && !included_roots.contains(&frame.id)
                        && graph.is_boundary(frame.id)
                        && !expanded_register_inputs.contains(&frame.id)
                        && !is_addressable_sequential_node(graph, frame.id)
                    {
                        boundary_nodes.insert(frame.id);
                        continue;
                    }
                    if frame.next_edge == 0 && frame.depth >= options.max_depth {
                        let visible = match has_visible_neighbor(
                            graph,
                            frame.id,
                            traversal.dir,
                            options.hide_control,
                            options.hide_const,
                            &mut examined_edges,
                            work_limits.max_examined_edges,
                        ) {
                            Ok(visible) => visible,
                            Err(()) => {
                                truncated = true;
                                break 'walk;
                            }
                        };
                        if visible {
                            boundary_nodes.insert(frame.id);
                            truncated = true;
                        }
                        continue;
                    }

                    let edge_ids = match traversal.dir {
                        ConeDir::Fanin => &graph.incoming[frame.id as usize],
                        ConeDir::Fanout => &graph.outgoing[frame.id as usize],
                    };
                    let Some(edge_idx) = edge_ids.get(frame.next_edge).copied() else {
                        continue 'frames;
                    };
                    frame.next_edge += 1;
                    let edge = &graph.edges[edge_idx];
                    if let Some(limit) = work_limits.max_examined_edges {
                        if examined_edges >= limit {
                            truncated = true;
                            break 'walk;
                        }
                        examined_edges += 1;
                    }
                    advanced = true;
                    let frame_id = frame.id;
                    let next_depth = frame.depth + 1;
                    if frame.next_edge < edge_ids.len() {
                        traversal.queue.push_back(frame);
                    }
                    let mut selected_root_pin = false;
                    if included_roots.len() == 1
                        && included_roots.contains(&frame_id)
                        && let Some(root_port) = options.root_port
                    {
                        let edge_port = match traversal.dir {
                            ConeDir::Fanin => edge.to_port.as_str(),
                            ConeDir::Fanout => edge.from_port.as_str(),
                        };
                        if edge_port != root_port
                            || options.root_port_bit.is_some_and(|bit| {
                                traversal.dir == ConeDir::Fanin && edge.to_port_bit != bit
                            })
                            || options.root_port_bits.is_some_and(|bits| {
                                traversal.dir == ConeDir::Fanin && !bits.contains(&edge.to_port_bit)
                            })
                        {
                            break 'frames;
                        }
                        selected_root_pin = true;
                    }
                    if !selected_root_pin
                        && should_hide_edge(graph, edge, options.hide_control, options.hide_const)
                    {
                        break 'frames;
                    }
                    if traversal.dir == ConeDir::Fanin
                        && is_addressable_sequential_node(graph, frame_id)
                        && !included_roots.contains(&frame_id)
                        && !is_depth_input_edge(graph, edge)
                    {
                        break 'frames;
                    }
                    if traversal.dir == ConeDir::Fanout
                        && is_addressable_sequential_node(graph, frame_id)
                        && !included_roots.contains(&frame_id)
                        && !is_depth_output_edge(graph, edge)
                    {
                        break 'frames;
                    }
                    if !edge_set.contains(&edge_idx) {
                        let key = (
                            edge.from,
                            edge.to,
                            edge.from_port.clone(),
                            edge.to_port.clone(),
                        );
                        let count = raw_edges_per_connection.entry(key).or_default();
                        if *count >= MAX_FULL_GROUP_MEMBERS {
                            truncated = true;
                            break 'frames;
                        }
                        if work_limits
                            .max_raw_edges
                            .is_some_and(|limit| edge_set.len() >= limit)
                        {
                            truncated = true;
                            break 'walk;
                        }
                        *count += 1;
                    }
                    let next = match traversal.dir {
                        ConeDir::Fanin => edge.from,
                        ConeDir::Fanout => edge.to,
                    };
                    if !seen.contains(&next) {
                        if work_limits
                            .max_raw_nodes
                            .is_some_and(|limit| seen.len() >= limit)
                        {
                            truncated = true;
                            break 'walk;
                        }
                        let unit = unit_id(grouping, base, next);
                        if !seen_units.contains(&unit) && seen_units.len() >= cap {
                            truncated = true;
                            break;
                        }
                        seen_units.insert(unit);
                        seen.insert(next);
                    }
                    if work_limits.expand_output_register_inputs
                        && traversal.dir == ConeDir::Fanin
                        && output_register_frontier.contains(&frame_id)
                    {
                        if graph.nodes[next as usize]
                            .cell_type
                            .as_deref()
                            .is_some_and(is_register_type)
                        {
                            expanded_register_inputs.insert(next);
                        } else if graph.nodes[next as usize]
                            .cell_type
                            .as_deref()
                            .is_some_and(is_transparent_data_buffer)
                        {
                            output_register_frontier.insert(next);
                        }
                    }
                    let stop_at_state_input = traversal.dir == ConeDir::Fanout
                        && is_addressable_sequential_node(graph, next)
                        && !is_depth_input_edge(graph, edge);
                    let stop_at_fixed_state_output = traversal.dir == ConeDir::Fanin
                        && is_addressable_sequential_node(graph, next)
                        && !is_depth_output_edge(graph, edge);
                    if stop_at_state_input || stop_at_fixed_state_output {
                        boundary_nodes.insert(next);
                    } else if traversal.seen.insert(next) {
                        traversal.queue.push_back(TraversalFrame {
                            id: next,
                            depth: next_depth,
                            next_edge: 0,
                        });
                    }
                    edge_set.insert(edge_idx);
                    break 'frames;
                }
            }
            if !advanced {
                break;
            }
        }

        // A focused data cone stops at sequential boundaries, but visible
        // registers still need their clock/reset/enable wiring when controls
        // are enabled. Attach one control hop without opening a second data
        // traversal through the boundary.
        if !options.hide_control {
            let mut sequential_nodes: Vec<NodeId> = seen
                .iter()
                .copied()
                .filter(|id| {
                    graph.nodes[*id as usize].seq
                        && !(options.root_port.is_some() && included_roots.contains(id))
                })
                .collect();
            sequential_nodes.sort_unstable();
            'controls: for id in sequential_nodes {
                for edge_idx in graph.incoming[id as usize].iter().copied() {
                    if edge_set.contains(&edge_idx) {
                        continue;
                    }
                    if let Some(limit) = work_limits.max_examined_edges
                        && examined_edges >= limit
                    {
                        truncated = true;
                        break 'controls;
                    }
                    examined_edges += 1;
                    let edge = &graph.edges[edge_idx];
                    if !is_labeled_control_edge(graph, edge)
                        || should_hide_edge(graph, edge, false, options.hide_const)
                    {
                        continue;
                    }
                    let key = (
                        edge.from,
                        edge.to,
                        edge.from_port.clone(),
                        edge.to_port.clone(),
                    );
                    if raw_edges_per_connection.get(&key).copied().unwrap_or(0)
                        >= MAX_FULL_GROUP_MEMBERS
                    {
                        truncated = true;
                        continue;
                    }
                    if work_limits
                        .max_raw_edges
                        .is_some_and(|limit| edge_set.len() >= limit)
                    {
                        truncated = true;
                        break 'controls;
                    }
                    if !seen.contains(&edge.from) {
                        if work_limits
                            .max_raw_nodes
                            .is_some_and(|limit| seen.len() >= limit)
                        {
                            truncated = true;
                            continue;
                        }
                        let unit = unit_id(grouping, base, edge.from);
                        if !seen_units.contains(&unit) && seen_units.len() >= cap {
                            truncated = true;
                            continue;
                        }
                        seen_units.insert(unit);
                        seen.insert(edge.from);
                    }
                    *raw_edges_per_connection.entry(key).or_default() += 1;
                    edge_set.insert(edge_idx);
                }
            }
        }

        let hidden_control_ports = options
            .hide_control
            .then_some(&self.pure_hidden_control_ports);
        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &included_roots,
                protected_nodes: &included_roots,
                boundary_nodes: &boundary_nodes,
                truncated,
                hidden_control_ports,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: work_limits
                    .max_examined_edges
                    .map(|limit| limit.saturating_sub(examined_edges)),
            },
        );
        Some(match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph.into_public(),
        })
    }

    pub fn full_netlist(
        &self,
        graph: &Graph,
        options: FullNetlistOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Subgraph {
        if !options.priority_roots.is_empty() {
            return self.context_netlist(graph, options, grouping);
        }
        let base = graph.nodes.len() as u32;
        let cap = options.max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
        let mut seen_units: HashSet<u32> = HashSet::new();

        // A group's members can be non-contiguous, so a full projection scans
        // all nodes. Selection context takes the bounded adjacency path above.
        let mut seen = HashSet::new();
        let mut truncated = false;
        let hidden_control_ports = options
            .hide_control
            .then_some(&self.pure_hidden_control_ports);
        let mut selected_groups: Vec<(GroupId, &crate::grouping::Group)> = Vec::new();
        let mut selected_group_ids = HashSet::new();

        // Logical memories are the highest-value grouping boundary and their
        // mapped DFFs may sort after thousands of helper cells. Reserve one raw
        // representative per memory, but never its whole membership, before
        // admitting other graph units.
        if let Some(projection) = grouping.filter(|projection| projection.memories) {
            for (group_id, group) in projection.partition.groups.iter().enumerate() {
                if group.kind != GroupKind::Memory {
                    continue;
                }
                if seen_units.len() >= cap || seen.len() >= MAX_SUBGRAPH_NODES {
                    truncated = true;
                    continue;
                }
                let unit = base + group_id as u32;
                seen_units.insert(unit);
                if let Some(&first) = group.members.first() {
                    seen.insert(first);
                    selected_group_ids.insert(group_id as GroupId);
                    selected_groups.push((group_id as GroupId, group));
                }
            }
        }

        // First admit distinct display units in graph order. A wide group pays
        // for one representative here, so it cannot consume the raw-node cap
        // before connected singleton/group units have a chance to appear.
        for node in &graph.nodes {
            if options.hide_const && node.kind == NodeKind::Const {
                continue;
            }
            if hidden_control_ports.is_some_and(|ports| ports.contains(&node.id)) {
                continue;
            }
            let unit = unit_id(grouping, base, node.id);
            if seen_units.contains(&unit) {
                continue;
            } else if seen_units.len() < cap && seen.len() < MAX_SUBGRAPH_NODES {
                seen_units.insert(unit);
                seen.insert(node.id);
                if let Some((group_id, group)) =
                    grouping.and_then(|projection| projection.group(node.id))
                    && selected_group_ids.insert(group_id)
                {
                    selected_groups.push((group_id, group));
                }
            } else {
                truncated = true;
            }
        }

        // Distribute additional group representatives round-robin. Evenly
        // spaced indices keep large DFF-backed memories and buses from sampling
        // only their earliest rows/bits, and every selected unit receives one
        // member before any unit receives a second.
        let sample_limits: Vec<usize> = selected_groups
            .iter()
            .map(|(_, group)| group.members.len().min(MAX_FULL_GROUP_MEMBERS))
            .collect();
        let group_sample_budget = selected_groups
            .len()
            .saturating_add(MAX_SUBGRAPH_NODES.saturating_sub(seen.len()));
        let sample_counts = waterfilled_sample_counts(&sample_limits, group_sample_budget);
        let max_sample = sample_counts.iter().copied().max().unwrap_or(0);
        let mut sample_index = 1usize;
        while sample_index < max_sample {
            let mut advanced = false;
            for (index, (_, group)) in selected_groups.iter().enumerate() {
                let target = sample_counts[index];
                if sample_index >= target {
                    continue;
                }
                if seen.len() >= MAX_SUBGRAPH_NODES {
                    truncated = true;
                    break;
                }
                let member_index = sample_index * (group.members.len() - 1) / (target - 1);
                seen.insert(group.members[member_index]);
                advanced = true;
            }
            if seen.len() >= MAX_SUBGRAPH_NODES || !advanced {
                break;
            }
            sample_index += 1;
        }
        truncated |= selected_groups
            .iter()
            .any(|(_, group)| group.members.iter().any(|member| !seen.contains(member)));
        let mut edge_set = HashSet::new();
        let mut raw_edges_per_connection: HashMap<(NodeId, NodeId, String, String), usize> =
            HashMap::new();
        let mut examined_edges = 0usize;
        let mut edge_frontiers: VecDeque<(NodeId, usize)> = graph
            .nodes
            .iter()
            .filter(|node| seen.contains(&node.id) && !graph.outgoing[node.id as usize].is_empty())
            .map(|node| (node.id, 0))
            .collect();
        while let Some((id, next_edge)) = edge_frontiers.pop_front() {
            if examined_edges >= MAX_FULL_NETLIST_EDGE_VISITS {
                truncated = true;
                break;
            }
            let outgoing = &graph.outgoing[id as usize];
            let Some(&idx) = outgoing.get(next_edge) else {
                continue;
            };
            if next_edge + 1 < outgoing.len() {
                edge_frontiers.push_back((id, next_edge + 1));
            }
            examined_edges += 1;
            let edge = &graph.edges[idx];
            if !seen.contains(&edge.to)
                || (options.hide_control && is_labeled_control_edge(graph, edge))
            {
                continue;
            }
            let key = (
                edge.from,
                edge.to,
                edge.from_port.clone(),
                edge.to_port.clone(),
            );
            let count = raw_edges_per_connection.entry(key).or_default();
            if *count >= MAX_FULL_GROUP_MEMBERS {
                truncated = true;
                continue;
            }
            if edge_set.len() >= MAX_SUBGRAPH_EDGES {
                truncated = true;
                break;
            }
            *count += 1;
            edge_set.insert(idx);
        }
        let empty = HashSet::new();
        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                protected_nodes: &empty,
                boundary_nodes: &empty,
                truncated,
                hidden_control_ports,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: Some(
                    MAX_FULL_NETLIST_EDGE_VISITS.saturating_sub(examined_edges),
                ),
            },
        );
        match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph.into_public(),
        }
    }

    /// Bounded undirected context around relevant roots. Unlike a full-netlist
    /// projection this walks only admitted adjacency, so changing selections
    /// does not rescan every graph node and edge or fill spare capacity with an
    /// arbitrary disconnected prefix.
    fn context_netlist(
        &self,
        graph: &Graph,
        options: FullNetlistOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Subgraph {
        let base = graph.nodes.len() as u32;
        let cap = options.max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
        let (priority_roots, roots_truncated) = bounded_projection_roots(
            options.priority_roots,
            grouping,
            base,
            cap,
            MAX_SUBGRAPH_NODES / 2,
        );
        let protected_nodes: HashSet<NodeId> = priority_roots.iter().copied().collect();
        let mut seen_units = HashSet::new();
        let mut seen = HashSet::new();
        let mut queued = HashSet::new();
        let mut queue = VecDeque::new();
        let mut edge_set = HashSet::new();
        let mut raw_edges_per_connection: HashMap<(NodeId, NodeId, String, String), usize> =
            HashMap::new();
        let mut examined_edges = 0usize;
        let mut truncated = roots_truncated;

        let admit = |id: NodeId,
                     seen_units: &mut HashSet<u32>,
                     seen: &mut HashSet<NodeId>,
                     queued: &mut HashSet<NodeId>,
                     queue: &mut VecDeque<(NodeId, usize)>,
                     truncated: &mut bool| {
            if seen.contains(&id) {
                return true;
            }
            let unit = unit_id(grouping, base, id);
            if (!seen_units.contains(&unit) && seen_units.len() >= cap)
                || seen.len() >= MAX_SUBGRAPH_NODES
            {
                return false;
            }
            seen_units.insert(unit);
            seen.insert(id);
            if queued.len() < FULL_NETLIST_CONTEXT_NODE_BUDGET && queued.insert(id) {
                queue.push_back((id, 0));
            } else if !queued.contains(&id) {
                *truncated = true;
            }
            true
        };

        for root in &priority_roots {
            if graph.nodes.get(*root as usize).is_none()
                || (options.hide_const && graph.nodes[*root as usize].kind == NodeKind::Const)
            {
                continue;
            }
            if !admit(
                *root,
                &mut seen_units,
                &mut seen,
                &mut queued,
                &mut queue,
                &mut truncated,
            ) {
                truncated = true;
                break;
            }
        }

        'context: while let Some((id, next_edge)) = queue.pop_front() {
            let incoming_len = graph.incoming[id as usize].len();
            let edge_idx = if next_edge < incoming_len {
                graph.incoming[id as usize].get(next_edge).copied()
            } else {
                graph.outgoing[id as usize]
                    .get(next_edge - incoming_len)
                    .copied()
            };
            let Some(edge_idx) = edge_idx else {
                continue;
            };
            queue.push_back((id, next_edge + 1));
            if examined_edges >= MAX_FULL_NETLIST_EDGE_VISITS {
                truncated = true;
                break 'context;
            }
            examined_edges += 1;
            let edge = &graph.edges[edge_idx];
            if options.hide_control && is_labeled_control_edge(graph, edge) {
                continue;
            }
            let neighbor = if edge.from == id { edge.to } else { edge.from };
            if options.hide_const && graph.nodes[neighbor as usize].kind == NodeKind::Const {
                continue;
            }
            if !admit(
                neighbor,
                &mut seen_units,
                &mut seen,
                &mut queued,
                &mut queue,
                &mut truncated,
            ) {
                truncated = true;
                continue;
            }
            if seen.contains(&edge.from) && seen.contains(&edge.to) {
                if !edge_set.contains(&edge_idx) {
                    let key = (
                        edge.from,
                        edge.to,
                        edge.from_port.clone(),
                        edge.to_port.clone(),
                    );
                    let count = raw_edges_per_connection.entry(key).or_default();
                    if *count >= MAX_FULL_GROUP_MEMBERS {
                        truncated = true;
                        continue;
                    }
                    if edge_set.len() >= MAX_SUBGRAPH_EDGES {
                        truncated = true;
                        break 'context;
                    }
                    *count += 1;
                }
                edge_set.insert(edge_idx);
            }
        }

        let hidden_control_ports = options
            .hide_control
            .then_some(&self.pure_hidden_control_ports);
        let empty = HashSet::new();
        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                protected_nodes: &protected_nodes,
                boundary_nodes: &empty,
                truncated,
                hidden_control_ports,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: Some(
                    MAX_FULL_NETLIST_EDGE_VISITS.saturating_sub(examined_edges),
                ),
            },
        );
        match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph.into_public(),
        }
    }

    /// Expand one quotient node without disabling grouping elsewhere. Every
    /// physical member is admitted before one-hop context, so an expansion is
    /// complete whenever the canonical group fits under the renderer cap.
    pub fn expand_group(
        &self,
        graph: &Graph,
        partition: &GroupPartition,
        group_id: GroupId,
        options: GroupExpansionOptions,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Option<GroupExpansion> {
        let group = partition.groups.get(group_id as usize)?;
        let cap = options.max_nodes.clamp(1, MAX_GROUP_EXPANSION_NODES);
        let members: Vec<NodeId> = group.members.iter().take(cap).copied().collect();
        let mut truncated = group.members.len() > members.len();

        let mut seen: HashSet<NodeId> = members.iter().copied().collect();
        let mut edge_set = HashSet::new();
        let mut examined_edges = 0usize;

        'members: for &member in &members {
            let incident = graph.incoming[member as usize]
                .iter()
                .chain(&graph.outgoing[member as usize]);
            for &edge_index in incident {
                if examined_edges >= MAX_GROUP_EXPANSION_EDGE_VISITS {
                    truncated = true;
                    break 'members;
                }
                examined_edges += 1;
                let edge = &graph.edges[edge_index];
                if options.hide_control && is_labeled_control_edge(graph, edge) {
                    continue;
                }
                let neighbor = if edge.from == member {
                    edge.to
                } else {
                    edge.from
                };
                if options.hide_const && graph.nodes[neighbor as usize].kind == NodeKind::Const {
                    continue;
                }
                if !seen.contains(&neighbor) {
                    if seen.len() >= cap {
                        truncated = true;
                        continue;
                    }
                    seen.insert(neighbor);
                }
                if edge_set.len() < MAX_SUBGRAPH_EDGES {
                    edge_set.insert(edge_index);
                } else {
                    truncated = true;
                }
            }
        }

        let empty = HashSet::new();
        let hidden_control_ports = options
            .hide_control
            .then_some(&self.pure_hidden_control_ports);
        let raw = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                protected_nodes: &empty,
                boundary_nodes: &empty,
                truncated,
                hidden_control_ports,
                show_infrastructure: false,
                max_control_edge_visits: Some(MAX_FULL_NETLIST_EDGE_VISITS),
            },
        );
        let (graph, boundary_trunks) = match grouping {
            Some(expanded_projection) => {
                let expanded_graph = quotient_subgraph(graph, raw, expanded_projection);
                let compact_group_id = graph.nodes.len() as u32 + group_id;
                let member_set = members.iter().copied().collect();
                let boundary_trunks =
                    group_expansion_boundary_trunks(&expanded_graph, compact_group_id, &member_set);
                (expanded_graph, boundary_trunks)
            }
            None => (raw.into_public(), Vec::new()),
        };
        Some(GroupExpansion {
            graph,
            members,
            boundary_trunks,
        })
    }

    pub fn fanout(&self, graph: &Graph, limit: usize) -> FanoutResponse {
        #[derive(Default)]
        struct Acc {
            fanout: usize,
            endpoints: HashSet<NodeId>,
            control: usize,
        }

        let mut groups: HashMap<(NodeId, String, String), Acc> = HashMap::new();
        for edge in &graph.edges {
            let Some(node) = graph.nodes.get(edge.from as usize) else {
                continue;
            };
            if matches!(node.kind, NodeKind::Const) {
                continue;
            }
            let key = (edge.from, edge.from_port.clone(), edge.net_name.clone());
            let acc = groups.entry(key).or_default();
            acc.fanout += 1;
            if edge.control {
                acc.control += 1;
            }
            if is_direct_endpoint(graph, edge.to) {
                acc.endpoints.insert(edge.to);
            }
        }

        let mut drivers: Vec<FanoutDriver> = groups
            .into_iter()
            .map(|((driver_id, port, net_name), acc)| FanoutDriver {
                driver: self.node_ref(graph, driver_id),
                port,
                net_name,
                fanout: acc.fanout,
                endpoints: acc.endpoints.len(),
                control: acc.control * 2 > acc.fanout,
            })
            .collect();
        drivers.sort_by_key(|driver| {
            (
                Reverse(driver.fanout),
                Reverse(driver.endpoints),
                driver.driver.name.clone(),
            )
        });
        drivers.truncate(limit);
        FanoutResponse { drivers }
    }

    fn path_for_target(
        &self,
        graph: &Graph,
        target: &EndpointTarget,
        node_cap: usize,
        alias_lookup: &RegisterAliasLookup<'_>,
        computation: &PathComputation<'_>,
    ) -> (PathEntry, bool, usize) {
        debug_assert!(node_cap >= 2);
        let mut node_ids = vec![target.endpoint];
        let mut clipped = false;
        if let Some(edge_idx) = target.edge {
            let mut downstream_edge = edge_idx;
            let mut current = graph.edges[edge_idx].from;
            loop {
                if node_ids.len() >= node_cap {
                    clipped = true;
                    break;
                }
                node_ids.push(current);
                if !is_depth_node(graph, current)
                    || !is_depth_output_edge(graph, &graph.edges[downstream_edge])
                {
                    break;
                }
                let pred = match computation.sort {
                    PathSort::Depth => &self.best_pred,
                    PathSort::Delay => computation.delay_pred,
                };
                let Some(pred_edge) = pred[current as usize] else {
                    break;
                };
                downstream_edge = pred_edge;
                current = graph.edges[pred_edge].from;
            }
        }
        let consumed_nodes = node_ids.len();
        let expected_startpoint = match computation.sort {
            PathSort::Depth => target.startpoint,
            PathSort::Delay => target
                .edge
                .and_then(|edge| computation.delay_startpoint[graph.edges[edge].from as usize])
                .unwrap_or(target.startpoint),
        };
        if clipped && node_ids.last().copied() != Some(expected_startpoint) {
            *node_ids
                .last_mut()
                .expect("an endpoint path always contains its endpoint") = expected_startpoint;
        }
        node_ids.reverse();
        let actual_startpoint = node_ids.first().copied().unwrap_or(expected_startpoint);
        let nodes: Vec<NodeRef> = node_ids
            .iter()
            .filter(|id| {
                **id == actual_startpoint
                    || **id == target.endpoint
                    || graph.nodes[**id as usize]
                        .cell_type
                        .as_deref()
                        .is_none_or(|cell_type| !is_infrastructure_cell(cell_type))
            })
            .map(|id| self.node_ref(graph, *id))
            .collect();
        let startpoint = self.node_ref(graph, actual_startpoint);
        let endpoint = self.node_ref(graph, target.endpoint);
        let class = classify_path(&startpoint, target.kind);
        let output_aliases = if target.kind == EndpointKind::Register {
            aliases_for_register_bit(alias_lookup, &target.group, target.bit)
        } else {
            Vec::new()
        };
        let route_delay = match computation.sort {
            PathSort::Depth => computation.depth_path_delay,
            PathSort::Delay => computation.node_delay,
        };
        let estimated_delay_ns = self.path_delay_ns(graph, target, route_delay, computation.model);
        (
            PathEntry {
                depth: target.depth,
                class,
                endpoint_group: target.group.clone(),
                endpoint_kind: target.kind,
                bits: vec![target.bit],
                output_aliases,
                startpoint,
                endpoint,
                endpoint_port: target.endpoint_port.clone(),
                nodes,
                estimated_delay_ns,
            },
            clipped,
            consumed_nodes,
        )
    }

    /// Estimated delay (ns) for a single endpoint's critical path, using the
    /// same accounting as the overview estimate: arrival at the last driver's
    /// output, plus that net, plus setup for register endpoints. Taken over all
    /// endpoints, the max matches the overview figure.
    fn path_delay_ns(
        &self,
        graph: &Graph,
        target: &EndpointTarget,
        node_delay: &[f64],
        model: &DelayModel,
    ) -> Option<f64> {
        let arrival_ps = match target.edge {
            Some(edge_idx) => {
                let from = graph.edges[edge_idx].from;
                // A comb driver contributes its computed arrival; a register/input
                // driver launches the path (clk-to-Q / zero), mirroring the DP.
                let base = if is_depth_node(graph, from) {
                    *node_delay.get(from as usize)?
                } else {
                    model.launch_ps(graph.nodes.get(from as usize)?.seq)
                };
                base + model.net_delay_ps(fanout_of(graph, from))
            }
            None => {
                let start = graph.nodes.get(target.startpoint as usize)?;
                model.launch_ps(start.seq) + model.net_delay_ps(fanout_of(graph, target.startpoint))
            }
        };
        let setup = if target.kind == EndpointKind::Register {
            model.ff_setup_ps
        } else {
            0.0
        };
        Some((arrival_ps + setup) / 1000.0)
    }

    fn subgraph_from_sets(
        &self,
        graph: &Graph,
        seen: &HashSet<NodeId>,
        edge_set: &HashSet<usize>,
        projection: SubgraphProjection<'_>,
    ) -> ProjectedSubgraph {
        let mut node_ids: Vec<NodeId> = seen
            .iter()
            .copied()
            .filter(|id| {
                projection.protected_nodes.contains(id)
                    || !projection
                        .hidden_control_ports
                        .is_some_and(|ports| ports.contains(id))
            })
            .collect();
        node_ids.sort_unstable();
        let visible_node_ids: HashSet<NodeId> = node_ids.iter().copied().collect();
        let mut control_edge_visits = 0usize;
        let mut controls_truncated = false;
        let nodes = node_ids
            .into_iter()
            .map(|id| {
                let node = &graph.nodes[id as usize];
                let boundary =
                    !projection.roots.contains(&id) && projection.boundary_nodes.contains(&id);
                let (controls, truncated) = node_controls(
                    graph,
                    id,
                    &mut control_edge_visits,
                    projection.max_control_edge_visits,
                );
                controls_truncated |= truncated;
                GraphNode {
                    node: self.node_ref(graph, id),
                    is_root: projection.roots.contains(&id).then_some(true),
                    is_boundary: boundary.then_some(true),
                    depth: graph
                        .is_comb(id)
                        .then(|| self.node_depth[id as usize])
                        .flatten(),
                    params: node.params.clone(),
                    controls,
                    width: None,
                    member_count: None,
                    members: None,
                    boundary_members: Vec::new(),
                }
            })
            .collect();
        let mut edges: Vec<&Edge> = edge_set
            .iter()
            .filter_map(|idx| graph.edges.get(*idx))
            .filter(|edge| {
                visible_node_ids.contains(&edge.from) && visible_node_ids.contains(&edge.to)
            })
            .collect();
        edges.sort_by(|a, b| compare_raw_edges(a, b));
        let (edges, edges_truncated) =
            merge_edges(edges, |edge| is_labeled_control_edge(graph, edge));
        let subgraph = Subgraph {
            nodes,
            edges,
            truncated: projection.truncated || edges_truncated || controls_truncated,
        };
        let projected = if projection.show_infrastructure {
            subgraph.into()
        } else {
            collapse_infrastructure(graph, subgraph)
        };
        cap_subgraph_edges(projected)
    }
}

struct SubgraphProjection<'a> {
    roots: &'a HashSet<NodeId>,
    protected_nodes: &'a HashSet<NodeId>,
    boundary_nodes: &'a HashSet<NodeId>,
    truncated: bool,
    hidden_control_ports: Option<&'a HashSet<NodeId>>,
    show_infrastructure: bool,
    max_control_edge_visits: Option<usize>,
}

fn path_node_signature(node: &NodeRef) -> String {
    match node.kind {
        ApiNodeKind::Cell => format!(
            "cell:{}:{}",
            node.cell_type.as_deref().unwrap_or("?"),
            node.seq == Some(true)
        ),
        ApiNodeKind::Port => "port".to_owned(),
        ApiNodeKind::Const => "const".to_owned(),
    }
}

fn compare_target_rank(a: &EndpointTarget, b: &EndpointTarget) -> Ordering {
    Reverse(a.depth)
        .cmp(&Reverse(b.depth))
        .then_with(|| a.bit.cmp(&b.bit))
        .then_with(|| a.endpoint.cmp(&b.endpoint))
        .then_with(|| a.endpoint_port.cmp(&b.endpoint_port))
}

fn compare_path_entries(a: &PathEntry, b: &PathEntry, sort: PathSort) -> Ordering {
    let tie_break = || compare_path_identity(a, b);
    match sort {
        PathSort::Depth => Reverse(a.depth).cmp(&Reverse(b.depth)).then_with(tie_break),
        PathSort::Delay => b
            .estimated_delay_ns
            .unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&a.estimated_delay_ns.unwrap_or(f64::NEG_INFINITY))
            .then_with(|| Reverse(a.depth).cmp(&Reverse(b.depth)))
            .then_with(tie_break),
    }
}

fn compare_path_membership(a: &PathEntry, b: &PathEntry) -> Ordering {
    Reverse(a.depth)
        .cmp(&Reverse(b.depth))
        .then_with(|| {
            b.estimated_delay_ns
                .unwrap_or(f64::NEG_INFINITY)
                .total_cmp(&a.estimated_delay_ns.unwrap_or(f64::NEG_INFINITY))
        })
        .then_with(|| compare_path_identity(a, b))
}

fn compare_path_identity(a: &PathEntry, b: &PathEntry) -> Ordering {
    a.endpoint_group
        .cmp(&b.endpoint_group)
        .then_with(|| a.endpoint_kind.cmp(&b.endpoint_kind))
        .then_with(|| a.class.cmp(&b.class))
        .then_with(|| a.endpoint_port.cmp(&b.endpoint_port))
        .then_with(|| a.bits.cmp(&b.bits))
        .then_with(|| {
            a.nodes
                .iter()
                .map(|node| node.id)
                .cmp(b.nodes.iter().map(|node| node.id))
        })
}

fn classify_path(startpoint: &NodeRef, endpoint_kind: EndpointKind) -> PathClass {
    let starts_at_register = startpoint.register == Some(true);
    let starts_at_input = startpoint.kind == ApiNodeKind::Port;
    match (starts_at_register, starts_at_input, endpoint_kind) {
        (true, _, EndpointKind::Register) => PathClass::RegisterToRegister,
        (_, true, EndpointKind::Register) => PathClass::InputToRegister,
        (true, _, EndpointKind::Output) => PathClass::RegisterToOutput,
        (_, true, EndpointKind::Output) => PathClass::InputToOutput,
        _ => PathClass::Other,
    }
}

type RegisterAliasLookup<'a> =
    HashMap<(&'a str, usize), Vec<(&'a OutputAlias, &'a OutputAliasBit)>>;

fn build_alias_lookup<'a>(
    endpoints: &'a EndpointsResponse,
    candidate_keys: &HashSet<(&str, usize)>,
) -> RegisterAliasLookup<'a> {
    let mut lookup: RegisterAliasLookup<'_> = HashMap::new();
    let mut candidate_bits_by_group: HashMap<&str, HashSet<usize>> = HashMap::new();
    for (group, bit) in candidate_keys {
        candidate_bits_by_group
            .entry(*group)
            .or_default()
            .insert(*bit);
    }
    for group in &endpoints.registers {
        let Some(candidate_bits) = candidate_bits_by_group.get(group.name.as_str()) else {
            continue;
        };
        for alias in &group.output_aliases {
            for bit in &alias.bits {
                if !candidate_bits.contains(&bit.register_bit) {
                    continue;
                }
                lookup
                    .entry((group.name.as_str(), bit.register_bit))
                    .or_default()
                    .push((alias, bit));
            }
        }
    }
    lookup
}

fn aliases_for_register_bit(
    lookup: &RegisterAliasLookup<'_>,
    register_group: &str,
    register_bit: usize,
) -> Vec<OutputAlias> {
    let Some(entries) = lookup.get(&(register_group, register_bit)) else {
        return Vec::new();
    };
    let mut aliases: BTreeMap<(&str, usize), Vec<OutputAliasBit>> = BTreeMap::new();
    for (alias, bit) in entries {
        aliases
            .entry((alias.name.as_str(), alias.width))
            .or_default()
            .push((*bit).clone());
    }
    aliases
        .into_iter()
        .map(|((name, width), mut bits)| {
            bits.sort_by_key(|bit| (bit.register_bit, bit.output_bit));
            bits.dedup_by_key(|bit| (bit.register_bit, bit.output_bit));
            OutputAlias {
                name: name.to_owned(),
                width,
                bits,
            }
        })
        .collect()
}

fn merge_output_aliases(existing: &mut Vec<OutputAlias>, incoming: Vec<OutputAlias>) {
    for alias in incoming {
        if let Some(current) = existing
            .iter_mut()
            .find(|current| current.name == alias.name)
        {
            current.bits.extend(alias.bits);
            current
                .bits
                .sort_by_key(|bit| (bit.register_bit, bit.output_bit));
            current
                .bits
                .dedup_by_key(|bit| (bit.register_bit, bit.output_bit));
        } else {
            existing.push(alias);
        }
    }
    existing.sort_by(|a, b| a.name.cmp(&b.name));
}

struct Traversal {
    dir: ConeDir,
    seen: HashSet<NodeId>,
    queue: VecDeque<TraversalFrame>,
}

#[derive(Clone, Copy, Default)]
struct SubgraphWorkLimits {
    expand_output_register_inputs: bool,
    max_raw_nodes: Option<usize>,
    max_raw_edges: Option<usize>,
    max_examined_edges: Option<usize>,
}

impl SubgraphWorkLimits {
    fn for_public_projection() -> Self {
        Self {
            max_raw_nodes: Some(MAX_SUBGRAPH_NODES),
            max_raw_edges: Some(MAX_SUBGRAPH_EDGES),
            max_examined_edges: Some(MAX_SUBGRAPH_EDGES),
            ..Self::default()
        }
    }

    fn for_source_selection(expand_output_register_inputs: bool) -> Self {
        Self {
            expand_output_register_inputs,
            max_raw_nodes: Some(MAX_SUBGRAPH_NODES),
            max_raw_edges: Some(MAX_SUBGRAPH_EDGES),
            max_examined_edges: Some(MAX_SUBGRAPH_EDGES),
        }
    }
}

struct TraversalFrame {
    id: NodeId,
    depth: u32,
    next_edge: usize,
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

/// The rendering unit a raw node belongs to: its group's synthetic id
/// (`base + group_id`, where `base = graph.nodes.len()`) when grouped, else the
/// node's own id. Synthetic ids never collide with real ids because real ids
/// are `< base`. With no partition every node is its own unit.
fn unit_id(grouping: Option<GroupingProjection<'_>>, base: u32, id: NodeId) -> u32 {
    match grouping.and_then(|projection| projection.group_id(id)) {
        Some(group_id) => base + group_id,
        None => id,
    }
}

/// Bound raw roots before traversal while preserving distinct projected units.
/// Ungrouped roots consume at most half the displayed-unit budget; enabled
/// groups may contribute a stratified representative sample without paying
/// additional displayed units. The remaining budgets stay available for
/// fanin/fanout context.
fn bounded_projection_roots(
    roots: &[NodeId],
    grouping: Option<GroupingProjection<'_>>,
    base: u32,
    max_units: usize,
    max_raw_roots: usize,
) -> (Vec<NodeId>, bool) {
    struct Bucket {
        grouped: bool,
        members: Vec<NodeId>,
    }

    let mut buckets = Vec::<Bucket>::new();
    let mut bucket_of = HashMap::<u32, usize>::new();
    let mut unique = HashSet::new();
    for &root in roots {
        if !unique.insert(root) {
            continue;
        }
        let unit = unit_id(grouping, base, root);
        let grouped = unit != root;
        let next = buckets.len();
        let index = *bucket_of.entry(unit).or_insert_with(|| {
            buckets.push(Bucket {
                grouped,
                members: Vec::new(),
            });
            next
        });
        buckets[index].members.push(root);
    }

    let max_root_units = max_units.saturating_div(2).max(1);
    let admitted_bucket_count = buckets.len().min(max_root_units).min(max_raw_roots);
    let admitted_bucket_indices: Vec<usize> = (0..admitted_bucket_count)
        .map(|sample_index| {
            if admitted_bucket_count <= 1 {
                0
            } else {
                sample_index * (buckets.len() - 1) / (admitted_bucket_count - 1)
            }
        })
        .collect();
    let mut bounded = Vec::with_capacity(max_raw_roots.min(roots.len()));
    let mut bounded_seen = HashSet::new();
    for &bucket_index in &admitted_bucket_indices {
        let bucket = &buckets[bucket_index];
        bounded.push(bucket.members[0]);
        bounded_seen.insert(bucket.members[0]);
    }

    let grouped_bucket_indices: Vec<usize> = admitted_bucket_indices
        .iter()
        .copied()
        .filter(|&bucket_index| buckets[bucket_index].grouped)
        .collect();
    let sample_limits: Vec<usize> = grouped_bucket_indices
        .iter()
        .map(|&bucket_index| {
            buckets[bucket_index]
                .members
                .len()
                .min(MAX_FULL_GROUP_MEMBERS)
        })
        .collect();
    let group_sample_budget = grouped_bucket_indices
        .len()
        .saturating_add(max_raw_roots.saturating_sub(bounded.len()));
    let sample_counts = waterfilled_sample_counts(&sample_limits, group_sample_budget);
    let max_sample = sample_counts.iter().copied().max().unwrap_or(0);
    let mut sample_index = 1usize;
    while sample_index < max_sample {
        let mut advanced = false;
        for (index, &bucket_index) in grouped_bucket_indices.iter().enumerate() {
            let bucket = &buckets[bucket_index];
            if bounded.len() >= max_raw_roots {
                continue;
            }
            let target = sample_counts[index];
            if sample_index >= target {
                continue;
            }
            let member_index = sample_index * (bucket.members.len() - 1) / (target - 1);
            let member = bucket.members[member_index];
            bounded.push(member);
            bounded_seen.insert(member);
            advanced = true;
        }
        if bounded.len() >= max_raw_roots || !advanced {
            break;
        }
        sample_index += 1;
    }

    let truncated = admitted_bucket_count < buckets.len()
        || admitted_bucket_indices.iter().any(|&bucket_index| {
            let bucket = &buckets[bucket_index];
            bucket
                .members
                .iter()
                .any(|member| !bounded_seen.contains(member))
        });
    (bounded, truncated)
}

/// Allocate a shared sample budget one position per bucket per round. Each
/// returned count is bounded by its corresponding limit. Callers then
/// stratify against that actual count so a globally capped bucket still spans
/// its entire canonical membership instead of prefix-sampling it.
fn waterfilled_sample_counts(limits: &[usize], budget: usize) -> Vec<usize> {
    let mut counts = vec![0usize; limits.len()];
    let mut remaining = budget;
    while remaining > 0 {
        let mut advanced = false;
        for (index, &limit) in limits.iter().enumerate() {
            if counts[index] >= limit || remaining == 0 {
                continue;
            }
            counts[index] += 1;
            remaining -= 1;
            advanced = true;
        }
        if !advanced {
            break;
        }
    }
    counts
}

/// Collapse a per-bit subgraph into its group quotient: every group's member
/// nodes become one synthetic node, edges are re-merged across the resulting
/// unit ids, and intra-group edges vanish. Ungrouped nodes pass through
/// unchanged; a singleton logical-memory group still becomes a synthetic node
/// so its source-level shape remains visible.
/// Runs after infrastructure collapse and edge capping, so synthetic ids are
/// never indexed back into `graph.nodes`.
fn quotient_subgraph(
    graph: &Graph,
    projected: impl Into<ProjectedSubgraph>,
    grouping: GroupingProjection<'_>,
) -> Subgraph {
    const MAX_MERGED_SRC_FRAGMENTS: usize = 8;
    let base = graph.nodes.len() as u32;
    let ProjectedSubgraph {
        mut subgraph,
        boundary_electrical,
    } = projected.into();

    struct GroupAcc {
        members: Vec<u32>,
        is_root: bool,
        is_boundary: bool,
        depth: Option<u32>,
        controls: Vec<ControlRef>,
        src_fragments: Vec<String>,
        src_truncated: bool,
    }

    let mut group_accs: BTreeMap<GroupId, GroupAcc> = BTreeMap::new();
    let mut nodes: Vec<GraphNode> = Vec::new();
    for node in std::mem::take(&mut subgraph.nodes) {
        let Some(group_id) = grouping.group_id(node.node.id) else {
            nodes.push(node);
            continue;
        };
        let acc = group_accs.entry(group_id).or_insert_with(|| GroupAcc {
            members: Vec::new(),
            is_root: false,
            is_boundary: false,
            depth: None,
            controls: Vec::new(),
            src_fragments: Vec::new(),
            src_truncated: false,
        });
        acc.members.push(node.node.id);
        acc.is_root |= node.is_root == Some(true);
        acc.is_boundary |= node.is_boundary == Some(true);
        if let Some(depth) = node.depth {
            acc.depth = Some(acc.depth.map_or(depth, |current| current.max(depth)));
        }
        if let Some(src) = node.node.src.as_deref() {
            for fragment in src.split('|') {
                if fragment.is_empty() || acc.src_fragments.iter().any(|kept| kept == fragment) {
                    continue;
                }
                if acc.src_fragments.len() == MAX_MERGED_SRC_FRAGMENTS {
                    acc.src_truncated = true;
                    break;
                } else {
                    acc.src_fragments.push(fragment.to_owned());
                }
            }
        }
        for control in node.controls {
            if !acc.controls.iter().any(|kept| {
                kept.role == control.role
                    && kept.pin == control.pin
                    && kept.net_name == control.net_name
                    && kept.driver_id == control.driver_id
                    && kept.active_low == control.active_low
                    && kept.synchronous == control.synchronous
                    && kept.generated == control.generated
            }) {
                acc.controls.push(control);
            }
        }
    }

    let mut src_truncated = false;
    for (group_id, acc) in group_accs {
        let group = &grouping.partition.groups[group_id as usize];
        let mut members = acc.members;
        members.sort_unstable();
        let register = matches!(group.kind, GroupKind::Register);
        let sequential = matches!(group.kind, GroupKind::Register | GroupKind::Memory);
        let src_fragments = acc.src_fragments;
        src_truncated |= acc.src_truncated;
        let is_root = acc.is_root;
        let is_port = matches!(group.kind, GroupKind::Port);
        let mut boundary_members = if is_port {
            members
                .iter()
                .filter_map(|&member| {
                    let bit = graph.nodes[member as usize].port_bit?;
                    Some(BoundaryMember {
                        member,
                        bit: u32::try_from(bit).expect("validated graph port slots fit in u32"),
                    })
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        boundary_members.sort_by_key(|entry| (entry.bit, entry.member));
        nodes.push(GraphNode {
            node: NodeRef {
                id: base + group_id,
                kind: if is_port {
                    ApiNodeKind::Port
                } else {
                    ApiNodeKind::Cell
                },
                name: group.label.clone(),
                // Port groups contain bits from one named top-level port, whose
                // declaration supplies one direction for every member.
                port_direction: is_port
                    .then_some(())
                    .and_then(|()| group.members.first())
                    .and_then(|id| graph.nodes[*id as usize].port_dir),
                cell_type: (!is_port).then(|| group.cell_type.clone()),
                seq: sequential.then_some(true),
                register: sequential.then(|| register && is_register_type(&group.cell_type)),
                src: (!src_fragments.is_empty()).then(|| src_fragments.join("|")),
            },
            is_root: is_root.then_some(true),
            is_boundary: (!is_root && acc.is_boundary).then_some(true),
            depth: acc.depth,
            params: BTreeMap::new(),
            controls: compact_group_controls(acc.controls),
            width: Some(members.len() as u32),
            member_count: Some(group.members.len() as u32),
            members: Some(members),
            boundary_members,
        });
    }
    nodes.sort_by_key(|node| node.node.id);

    // Re-merge edges across unit ids: intra-group edges (same unit both ends)
    // vanish; parallel bus edges collapse to one carrying every bit.
    struct MergedEdge {
        edge: GraphEdge,
        source_boundary_members: BTreeMap<u32, BTreeSet<u32>>,
        target_boundary_members: BTreeMap<u32, BTreeSet<u32>>,
    }

    let mut merged: BTreeMap<(u32, u32, String, String), MergedEdge> = BTreeMap::new();
    for (edge, provenance) in std::mem::take(&mut subgraph.edges)
        .into_iter()
        .zip(boundary_electrical)
    {
        let from = unit_id(Some(grouping), base, edge.from);
        let to = unit_id(Some(grouping), base, edge.to);
        if from == to {
            continue;
        }
        let key = (from, to, edge.from_port.clone(), edge.to_port.clone());
        let entry = merged.entry(key).or_insert_with(|| MergedEdge {
            edge: GraphEdge {
                from,
                to,
                from_port: edge.from_port.clone(),
                to_port: edge.to_port.clone(),
                // A bus edge carries the vector net, not one bit's `name[k]`.
                net_name: strip_bit_suffix(&edge.net_name).to_owned(),
                bits: Vec::new(),
                control: edge.control,
                source_boundary_members: Vec::new(),
                target_boundary_members: Vec::new(),
            },
            source_boundary_members: BTreeMap::new(),
            target_boundary_members: BTreeMap::new(),
        });
        entry.edge.bits.extend_from_slice(&edge.bits);
        if grouping
            .group(edge.from)
            .is_some_and(|(_, group)| matches!(group.kind, GroupKind::Port))
        {
            entry
                .source_boundary_members
                .entry(edge.from)
                .or_default()
                .extend(
                    provenance
                        .as_deref()
                        .and_then(|provenance| provenance.source_bits.as_deref())
                        .unwrap_or(&edge.bits)
                        .iter()
                        .copied(),
                );
        }
        if grouping
            .group(edge.to)
            .is_some_and(|(_, group)| matches!(group.kind, GroupKind::Port))
        {
            entry
                .target_boundary_members
                .entry(edge.to)
                .or_default()
                .extend(
                    provenance
                        .as_deref()
                        .and_then(|provenance| provenance.target_bits.as_deref())
                        .unwrap_or(&edge.bits)
                        .iter()
                        .copied(),
                );
        }
        if edge.control == Some(true) {
            entry.edge.control = Some(true);
        }
    }
    let edges = merged
        .into_values()
        .map(|mut merged| {
            merged.edge.bits.sort_unstable();
            merged.edge.bits.dedup();
            merged.edge.source_boundary_members = merged
                .source_boundary_members
                .into_iter()
                .map(|(member, net_bits)| EdgeBoundaryMember {
                    member,
                    net_bits: net_bits.into_iter().collect(),
                })
                .collect();
            merged.edge.source_boundary_members.sort_by_key(|entry| {
                (
                    graph.nodes[entry.member as usize]
                        .port_bit
                        .unwrap_or_default(),
                    entry.member,
                )
            });
            merged.edge.target_boundary_members = merged
                .target_boundary_members
                .into_iter()
                .map(|(member, net_bits)| EdgeBoundaryMember {
                    member,
                    net_bits: net_bits.into_iter().collect(),
                })
                .collect();
            merged.edge.target_boundary_members.sort_by_key(|entry| {
                (
                    graph.nodes[entry.member as usize]
                        .port_bit
                        .unwrap_or_default(),
                    entry.member,
                )
            });
            merged.edge
        })
        .collect();

    Subgraph {
        nodes,
        edges,
        truncated: subgraph.truncated || src_truncated,
    }
}

fn group_expansion_boundary_trunks(
    expanded: &Subgraph,
    compact_group_id: NodeId,
    members: &HashSet<NodeId>,
) -> Vec<GroupExpansionBoundaryTrunk> {
    let mut by_compact_edge: HashMap<ProjectedEdgeKey, HashSet<ProjectedEdgeKey>> = HashMap::new();
    for edge in &expanded.edges {
        let from_member = members.contains(&edge.from);
        let to_member = members.contains(&edge.to);
        if from_member == to_member {
            continue;
        }
        let compact_edge = ProjectedEdgeKey {
            from: if from_member {
                compact_group_id
            } else {
                edge.from
            },
            to: if to_member { compact_group_id } else { edge.to },
            from_port: edge.from_port.clone(),
            to_port: edge.to_port.clone(),
        };
        by_compact_edge
            .entry(compact_edge)
            .or_default()
            .insert(projected_edge_key(edge));
    }

    let mut trunks = by_compact_edge
        .into_iter()
        .map(|(compact_edge, expanded_edges)| {
            let mut expanded_edges = expanded_edges.into_iter().collect::<Vec<_>>();
            expanded_edges.sort();
            GroupExpansionBoundaryTrunk {
                compact_edge,
                expanded_edges,
            }
        })
        .collect::<Vec<_>>();
    trunks.sort_by(|left, right| left.compact_edge.cmp(&right.compact_edge));
    trunks
}

fn projected_edge_key(edge: &GraphEdge) -> ProjectedEdgeKey {
    ProjectedEdgeKey {
        from: edge.from,
        to: edge.to,
        from_port: edge.from_port.clone(),
        to_port: edge.to_port.clone(),
    }
}

/// Collapse repeated per-member control metadata into one row per compatible
/// role/pin/polarity. Grouped memories can contain hundreds of row-enable
/// nets; retaining every label would make one schematic node thousands of
/// pixels tall even though all edges already share the same logical pin.
fn compact_group_controls(controls: Vec<ControlRef>) -> Vec<ControlRef> {
    type ControlKey = (
        ControlRole,
        String,
        Option<bool>,
        Option<bool>,
        Option<bool>,
    );
    let mut groups: BTreeMap<ControlKey, Vec<ControlRef>> = BTreeMap::new();
    for control in controls {
        groups
            .entry((
                control.role,
                control.pin.clone(),
                control.active_low,
                control.synchronous,
                control.generated,
            ))
            .or_default()
            .push(control);
    }

    groups
        .into_values()
        .map(|mut controls| {
            controls.sort_by(|a, b| {
                a.net_name
                    .cmp(&b.net_name)
                    .then_with(|| a.driver_id.cmp(&b.driver_id))
            });
            let mut representative = controls.remove(0);
            if controls.is_empty() {
                return representative;
            }
            let mut driver_ids: BTreeSet<NodeId> = BTreeSet::from([representative.driver_id]);
            let mut fanout = representative.fanout;
            let shared_src = representative.src.clone();
            let mut same_src = true;
            for control in &controls {
                driver_ids.insert(control.driver_id);
                fanout = fanout.saturating_add(control.fanout);
                same_src &= control.src == shared_src;
            }
            representative.net_count = Some((controls.len() + 1) as u32);
            representative.driver_ids = driver_ids.into_iter().collect();
            representative.fanout = fanout;
            if !same_src {
                representative.src = None;
            }
            representative
        })
        .collect()
}

pub fn node_ref(graph: &Graph, id: NodeId) -> NodeRef {
    let node = &graph.nodes[id as usize];
    let kind = match node.kind {
        NodeKind::Cell => ApiNodeKind::Cell,
        NodeKind::PortBit => ApiNodeKind::Port,
        NodeKind::Const => ApiNodeKind::Const,
    };
    NodeRef {
        id,
        kind,
        name: node.name.clone(),
        port_direction: node.port_dir,
        cell_type: node.cell_type.clone(),
        seq: (node.kind == NodeKind::Cell && node.seq).then_some(node.seq),
        register: (node.kind == NodeKind::Cell && node.seq).then_some(is_register_node(node)),
        src: node.src.clone(),
    }
}

fn is_register_node(node: &crate::graph::Node) -> bool {
    node.kind == NodeKind::Cell
        && node.seq
        && !node.blackbox
        && node.cell_type.as_deref().is_some_and(is_register_type)
}

fn find_comb_loops(graph: &Graph) -> Vec<NodeId> {
    struct Frame {
        node: NodeId,
        next_edge: usize,
    }

    let mut index = 0;
    let mut indices = vec![None; graph.nodes.len()];
    let mut lowlink = vec![0; graph.nodes.len()];
    let mut stack = Vec::new();
    let mut on_stack = vec![false; graph.nodes.len()];
    let mut loops = HashSet::new();

    for start in &graph.nodes {
        if !is_depth_node(graph, start.id) || indices[start.id as usize].is_some() {
            continue;
        }

        indices[start.id as usize] = Some(index);
        lowlink[start.id as usize] = index;
        index += 1;
        stack.push(start.id);
        on_stack[start.id as usize] = true;
        let mut frames = vec![Frame {
            node: start.id,
            next_edge: 0,
        }];

        while let Some(frame) = frames.last_mut() {
            let node = frame.node;
            if frame.next_edge < graph.outgoing[node as usize].len() {
                let edge_idx = graph.outgoing[node as usize][frame.next_edge];
                frame.next_edge += 1;
                let next = graph.edges[edge_idx].to;
                if !is_depth_node(graph, next)
                    || !is_depth_output_edge(graph, &graph.edges[edge_idx])
                    || !is_depth_input_edge(graph, &graph.edges[edge_idx])
                {
                    continue;
                }
                if indices[next as usize].is_none() {
                    indices[next as usize] = Some(index);
                    lowlink[next as usize] = index;
                    index += 1;
                    stack.push(next);
                    on_stack[next as usize] = true;
                    frames.push(Frame {
                        node: next,
                        next_edge: 0,
                    });
                } else if on_stack[next as usize] {
                    lowlink[node as usize] =
                        lowlink[node as usize].min(indices[next as usize].unwrap_or(0));
                }
                continue;
            }

            let node = frames.pop().map(|frame| frame.node).unwrap_or(node);
            if lowlink[node as usize] == indices[node as usize].unwrap_or(usize::MAX) {
                let mut component = Vec::new();
                while let Some(member) = stack.pop() {
                    on_stack[member as usize] = false;
                    component.push(member);
                    if member == node {
                        break;
                    }
                }
                let self_loop = component.len() == 1
                    && graph.outgoing[component[0] as usize]
                        .iter()
                        .any(|edge_idx| {
                            let edge = &graph.edges[*edge_idx];
                            edge.to == component[0]
                                && is_depth_output_edge(graph, edge)
                                && is_depth_input_edge(graph, edge)
                        });
                if component.len() > 1 || self_loop {
                    loops.extend(component);
                }
            }
            if let Some(parent) = frames.last() {
                lowlink[parent.node as usize] =
                    lowlink[parent.node as usize].min(lowlink[node as usize]);
            }
        }
    }
    let mut loops: Vec<NodeId> = loops.into_iter().collect();
    loops.sort_unstable();
    loops
}

fn compute_depths(
    graph: &Graph,
    loop_set: &HashSet<NodeId>,
    model: &DelayModel,
) -> DepthComputation {
    let mut indegree = vec![0usize; graph.nodes.len()];
    for edge in &graph.edges {
        if is_depth_node(graph, edge.from)
            && is_depth_node(graph, edge.to)
            && is_depth_output_edge(graph, edge)
            && is_depth_input_edge(graph, edge)
            && !loop_set.contains(&edge.from)
            && !loop_set.contains(&edge.to)
        {
            indegree[edge.to as usize] += 1;
        }
    }

    let mut queue = VecDeque::new();
    for node in &graph.nodes {
        if is_depth_node(graph, node.id)
            && !loop_set.contains(&node.id)
            && indegree[node.id as usize] == 0
        {
            queue.push_back(node.id);
        }
    }

    let mut depth = vec![None; graph.nodes.len()];
    let mut best_pred = vec![None; graph.nodes.len()];
    let mut delay_pred = vec![None; graph.nodes.len()];
    let mut startpoint = vec![None; graph.nodes.len()];
    let mut delay_startpoint = vec![None; graph.nodes.len()];
    // Parallel delay-weighted longest path (picoseconds); see delay_model.
    let mut node_delay = vec![0.0f64; graph.nodes.len()];
    let mut depth_path_delay = vec![0.0f64; graph.nodes.len()];
    // Breakdown of that arrival (launch/logic/net) along the delay-max path.
    let mut node_breakdown = vec![DelayBreakdownPs::default(); graph.nodes.len()];

    while let Some(id) = queue.pop_front() {
        let cell = graph.nodes[id as usize].cell_type.as_deref();
        let weight = cell.map(cell_depth_weight).unwrap_or(1);
        let mut best: Option<(u32, usize, NodeId)> = None;
        let mut best_delay: Option<(f64, usize, NodeId)> = None;
        let mut best_bd = DelayBreakdownPs::default();
        for edge_idx in &graph.incoming[id as usize] {
            let edge = &graph.edges[*edge_idx];
            if loop_set.contains(&edge.from) || !is_depth_input_edge(graph, edge) {
                continue;
            }
            let follows_depth =
                is_depth_node(graph, edge.from) && is_depth_output_edge(graph, edge);
            let base = if follows_depth {
                depth[edge.from as usize].unwrap_or(0)
            } else {
                0
            };
            let candidate = base + weight;
            let origin = if follows_depth {
                startpoint[edge.from as usize].unwrap_or(edge.from)
            } else {
                edge.from
            };
            if best.is_none_or(|(current, _, _)| candidate > current) {
                best = Some((candidate, *edge_idx, origin));
            }
            // A path either continues from an upstream comb node's arrival time
            // or is launched here by a register (clk-to-Q) / input (zero).
            let (base_delay, base_bd) = if follows_depth {
                (
                    node_delay[edge.from as usize],
                    node_breakdown[edge.from as usize],
                )
            } else {
                let launch = model.launch_ps(graph.nodes[edge.from as usize].seq);
                (
                    launch,
                    DelayBreakdownPs {
                        launch,
                        ..Default::default()
                    },
                )
            };
            let delay_origin = if follows_depth {
                delay_startpoint[edge.from as usize].unwrap_or(edge.from)
            } else {
                edge.from
            };
            // The sink is `id`; a connection into a carry chain is dedicated.
            let net = model.net_delay_to_ps(
                graph.nodes[id as usize].cell_type.as_deref(),
                fanout_of(graph, edge.from),
            );
            let candidate_delay = base_delay + net;
            if best_delay.is_none_or(|(current, _, _)| candidate_delay > current) {
                best_delay = Some((candidate_delay, *edge_idx, delay_origin));
                best_bd = base_bd;
                best_bd.net += net;
            }
        }
        let (node_depth, pred, origin) = best.unwrap_or((weight, usize::MAX, id));
        depth[id as usize] = Some(node_depth);
        startpoint[id as usize] = Some(origin);
        let cell_ps = cell
            .map(|cell_type| model.cell_delay_ps(cell_type))
            .unwrap_or(model.cell_ps);
        let depth_base = if pred == usize::MAX {
            0.0
        } else {
            let edge = &graph.edges[pred];
            let follows_depth =
                is_depth_node(graph, edge.from) && is_depth_output_edge(graph, edge);
            let base = if follows_depth {
                depth_path_delay[edge.from as usize]
            } else {
                model.launch_ps(graph.nodes[edge.from as usize].seq)
            };
            base + model.net_delay_to_ps(cell, fanout_of(graph, edge.from))
        };
        depth_path_delay[id as usize] = depth_base + cell_ps;
        let (best_delay, delay_edge, delay_origin) = best_delay.unwrap_or((0.0, usize::MAX, id));
        node_delay[id as usize] = best_delay + cell_ps;
        best_bd.logic += cell_ps;
        node_breakdown[id as usize] = best_bd;
        delay_startpoint[id as usize] = Some(delay_origin);
        if pred != usize::MAX {
            best_pred[id as usize] = Some(pred);
        }
        if delay_edge != usize::MAX {
            delay_pred[id as usize] = Some(delay_edge);
        }

        for edge_idx in &graph.outgoing[id as usize] {
            let edge = &graph.edges[*edge_idx];
            let next = edge.to;
            if is_depth_node(graph, next)
                && is_depth_output_edge(graph, edge)
                && is_depth_input_edge(graph, edge)
                && !loop_set.contains(&next)
            {
                indegree[next as usize] = indegree[next as usize].saturating_sub(1);
                if indegree[next as usize] == 0 {
                    queue.push_back(next);
                }
            }
        }
    }

    // Worst arrival at a data sink, plus the driver's output net and the
    // capturing register's setup — the estimated critical path. Every timing
    // path ends at a data sink; scoring the sinks rather than every node keeps
    // the clock tree and dangling logic out of the estimate.
    let mut best_arrival: Option<(f64, bool)> = None;
    let mut best_arrival_bd: Option<DelayBreakdownPs> = None;
    let mut best_arrival_starts_at_register = None;
    let mut best_arrival_endpoint_kind = None;
    for edge in &graph.edges {
        if !is_data_sink_edge(graph, edge) || loop_set.contains(&edge.from) {
            continue;
        }
        let from = edge.from;
        let (base_delay, base_bd) =
            if is_depth_node(graph, from) && is_depth_output_edge(graph, edge) {
                // Unreached (or clock-network) driver: no data arrival to score.
                if depth[from as usize].is_none() {
                    continue;
                }
                (node_delay[from as usize], node_breakdown[from as usize])
            } else if graph.nodes[from as usize].kind == NodeKind::Const {
                // A constant tied to a data pin is not a timing path.
                continue;
            } else {
                // A register drives the sink directly: it launches its own path
                // (clk-to-Q) with zero logic levels. A top-level input starts at
                // zero. Without this a purely register-to-register design — no
                // combinational cells at all — would report no estimate.
                let launch = model.launch_ps(graph.nodes[from as usize].seq);
                (
                    launch,
                    DelayBreakdownPs {
                        launch,
                        ..Default::default()
                    },
                )
            };
        let net = model.net_delay_ps(fanout_of(graph, from));
        let arrival = base_delay + net;
        let endpoint_is_register = graph.nodes[edge.to as usize].seq;
        let candidate = arrival
            + if endpoint_is_register {
                model.ff_setup_ps
            } else {
                0.0
            };
        if best_arrival.is_none_or(|(current, _)| candidate > current) {
            best_arrival = Some((candidate, endpoint_is_register));
            let mut bd = base_bd;
            bd.net += net;
            best_arrival_bd = Some(bd);
            let origin = if is_depth_node(graph, from) && is_depth_output_edge(graph, edge) {
                startpoint[from as usize].unwrap_or(from)
            } else {
                from
            };
            best_arrival_starts_at_register = Some(
                graph
                    .nodes
                    .get(origin as usize)
                    .is_some_and(|node| node.seq),
            );
            best_arrival_endpoint_kind = Some(match graph.nodes[edge.to as usize].kind {
                NodeKind::PortBit => EndpointKind::Output,
                NodeKind::Cell => EndpointKind::Register,
                NodeKind::Const => unreachable!("a constant cannot be a data sink"),
            });
        }
    }
    let estimated_max_delay_ps = best_arrival.map(|(delay, _)| delay);
    let estimated_max_delay_breakdown = best_arrival_bd.map(|mut bd| {
        bd.setup = if best_arrival.is_some_and(|(_, register)| register) {
            model.ff_setup_ps
        } else {
            0.0
        };
        bd
    });

    DepthComputation {
        node_depth: depth,
        best_pred,
        delay_pred,
        node_startpoint: startpoint,
        delay_startpoint,
        estimated_max_delay_ps,
        estimated_max_delay_breakdown,
        estimated_max_delay_starts_at_register: best_arrival_starts_at_register,
        estimated_max_delay_endpoint_kind: best_arrival_endpoint_kind,
        node_delay,
        depth_path_delay,
    }
}

/// Number of sinks a node's output drives — the fanout used by the net-delay
/// estimate.
fn fanout_of(graph: &Graph, id: NodeId) -> u32 {
    graph.outgoing[id as usize].len() as u32
}

/// The estimated worst-case delay and its breakdown for a design under `model`.
pub struct TimingEstimate {
    pub delay_ns: Option<f64>,
    pub breakdown: Option<DelayBreakdown>,
    pub starts_at_register: Option<bool>,
    pub endpoint_kind: Option<EndpointKind>,
}

fn is_addressable_sequential_node(graph: &Graph, id: NodeId) -> bool {
    graph.nodes.get(id as usize).is_some_and(|node| {
        node.cell_type
            .as_deref()
            .is_some_and(is_addressable_sequential_type)
    })
}

fn is_depth_node(graph: &Graph, id: NodeId) -> bool {
    // The clock network reaches nothing but register clock pins. It is not
    // data, so it carries neither logical depth nor a data arrival time.
    if graph.is_clock_network(id) {
        return false;
    }
    graph.is_comb(id) || is_addressable_sequential_node(graph, id)
}

/// Whether an edge lands on a sink that *closes* a timing path: a storage
/// cell's data pin (which imposes setup) or a top-level output port.
///
/// Combinational fanout does not close a path — it continues into the next
/// cell, which is scored on its own. Neither does a control pin, matching the
/// endpoints the rest of the analysis reports (see `endpoint_data_edges`).
/// Without this test every combinational node is an endpoint "just because it
/// exists", which is what charges a register setup onto a clock buffer.
fn is_data_sink_edge(graph: &Graph, edge: &Edge) -> bool {
    if edge.control {
        return false;
    }
    let Some(sink) = graph.nodes.get(edge.to as usize) else {
        return false;
    };
    match sink.kind {
        NodeKind::PortBit => {
            matches!(
                sink.port_dir,
                Some(PortDirection::Output | PortDirection::Inout)
            )
            // A directly-registered output is reported as an alias of the
            // register group rather than as an endpoint of its own (see
            // `discover_endpoints`), so it closes no path here either — the
            // driving register's own `D` endpoint already carries its timing.
            // Scoring it as well would put a figure in the overview that no
            // reported path can explain.
            && direct_register_driver(graph, sink.id).is_none()
        }
        // An addressable sequential's `A*` select pins feed its output
        // combinationally, so they continue the path rather than ending it.
        NodeKind::Cell => {
            sink.seq
                && (!is_addressable_sequential_node(graph, edge.to)
                    || !is_depth_input_edge(graph, edge))
        }
        NodeKind::Const => false,
    }
}

fn is_depth_input_edge(graph: &Graph, edge: &Edge) -> bool {
    if !is_addressable_sequential_node(graph, edge.to) {
        return true;
    }
    edge.to_port
        .strip_prefix('A')
        .is_some_and(|suffix| suffix.chars().all(|ch| ch.is_ascii_digit()))
}

fn is_depth_output_edge(graph: &Graph, edge: &Edge) -> bool {
    if !is_addressable_sequential_node(graph, edge.from) {
        return true;
    }
    let fixed_tap = graph.nodes[edge.from as usize]
        .cell_type
        .as_deref()
        .is_some_and(|cell_type| cell_type.eq_ignore_ascii_case("SRLC32E"))
        && edge.from_port.eq_ignore_ascii_case("Q31");
    !fixed_tap
}

fn discover_endpoints(
    graph: &Graph,
    node_depth: &[Option<u32>],
    node_startpoint: &[Option<NodeId>],
    source_files: &[String],
) -> (EndpointsResponse, Vec<EndpointTarget>, bool) {
    let design_files: HashSet<&str> = source_files.iter().map(String::as_str).collect();
    let mut targets = Vec::new();
    let mut register_map: BTreeMap<String, RegisterGroup> = BTreeMap::new();
    let mut register_bits: HashMap<(NodeId, Option<u32>), (String, usize)> = HashMap::new();
    let mut boundaries = Vec::new();
    let mut boundary_bit_count = 0;
    let mut boundary_target_count = 0;
    let mut boundaries_truncated = false;
    let mut endpoint_targets_truncated = false;

    for node in &graph.nodes {
        if !is_register_node(node) {
            continue;
        }
        let Some(info) = graph.cell_info.get(&node.id) else {
            continue;
        };
        let q_width = info.q_bits.len().max(1);
        let group_name = register_group_name(graph, node, info, &design_files);
        let cell_type = node.cell_type.clone().unwrap_or_default();
        let mut bits = Vec::new();
        let data_edges = endpoint_data_edges(graph, node.id, info, q_width);
        for (bit_idx, edge) in data_edges.into_iter().enumerate() {
            let display_bit = info
                .q_bits
                .get(bit_idx)
                .and_then(|bit| bit.net())
                .and_then(|net| register_q_name(graph, net))
                .and_then(bit_index_from_name)
                .or_else(|| bit_index_from_name(&node.name))
                .unwrap_or(bit_idx);
            let depth = edge.map_or(0, |idx| edge_depth(graph, node_depth, idx));
            bits.push(EndpointBit {
                bit: display_bit,
                node_id: node.id,
                depth,
            });
            register_bits.insert(
                (node.id, info.q_bits.get(bit_idx).and_then(|bit| bit.net())),
                (group_name.clone(), display_bit),
            );
            targets.push(EndpointTarget {
                endpoint: node.id,
                endpoint_port: "D".to_owned(),
                edge,
                startpoint: endpoint_startpoint_id(graph, node_startpoint, node.id, edge),
                depth,
                group: group_name.clone(),
                kind: EndpointKind::Register,
                bit: display_bit,
            });
        }
        let entry = register_map
            .entry(group_name.clone())
            .or_insert(RegisterGroup {
                name: group_name,
                width: 0,
                cell_type,
                clock: info.clock_net.clone(),
                src: node.src.clone(),
                worst_depth: 0,
                bits: Vec::new(),
                output_aliases: Vec::new(),
            });
        entry.width += bits.len();
        entry.worst_depth = entry
            .worst_depth
            .max(bits.iter().map(|bit| bit.depth).max().unwrap_or_default());
        entry.bits.extend(bits);
    }
    for register in register_map.values_mut() {
        register.bits.sort_by_key(|bit| bit.bit);
    }

    let mut outputs = Vec::new();
    let mut inputs = Vec::new();
    let mut output_aliases: BTreeMap<(String, String, usize), Vec<OutputAliasBit>> =
        BTreeMap::new();
    let mut port_groups: BTreeMap<String, Vec<&crate::graph::Node>> = BTreeMap::new();
    for node in &graph.nodes {
        if node.kind == NodeKind::PortBit
            && let Some(port) = &node.port
        {
            port_groups.entry(port.clone()).or_default().push(node);
        }
    }
    for (name, mut nodes) in port_groups {
        nodes.sort_by_key(|node| node.port_bit.unwrap_or_default());
        let Some(dir) = nodes.first().and_then(|node| node.port_dir) else {
            continue;
        };
        if matches!(dir, PortDirection::Input | PortDirection::Inout) {
            inputs.push(InputGroup {
                name: name.clone(),
                width: nodes.len(),
                bits: nodes
                    .iter()
                    .map(|node| InputBit {
                        bit: node.port_bit.unwrap_or_default(),
                        node_id: node.id,
                    })
                    .collect(),
            });
        }
        if matches!(dir, PortDirection::Output | PortDirection::Inout) {
            let output_width = nodes.len();
            let mut bits = Vec::new();
            for node in nodes {
                let output_bit = node.port_bit.unwrap_or_default();
                if let Some((register_node, register_net)) = direct_register_driver(graph, node.id)
                    && let Some((group_name, register_bit)) = register_bits
                        .get(&(register_node, register_net))
                        .or_else(|| register_bits.get(&(register_node, None)))
                {
                    output_aliases
                        .entry((group_name.clone(), name.clone(), output_width))
                        .or_default()
                        .push(OutputAliasBit {
                            output_bit,
                            register_bit: *register_bit,
                        });
                    continue;
                }

                let edge = best_endpoint_edge(graph, node_depth, node.id, None);
                let depth = edge.map_or(0, |idx| edge_depth(graph, node_depth, idx));
                targets.push(EndpointTarget {
                    endpoint: node.id,
                    endpoint_port: name.clone(),
                    edge,
                    startpoint: endpoint_startpoint_id(graph, node_startpoint, node.id, edge),
                    depth,
                    group: name.clone(),
                    kind: EndpointKind::Output,
                    bit: output_bit,
                });
                bits.push(EndpointBit {
                    bit: output_bit,
                    node_id: node.id,
                    depth,
                });
            }
            if !bits.is_empty() {
                outputs.push(OutputGroup {
                    name,
                    width: output_width,
                    worst_depth: bits.iter().map(|bit| bit.depth).max().unwrap_or_default(),
                    bits,
                });
            }
        }
    }

    for ((register_name, output_name, width), mut bits) in output_aliases {
        bits.sort_by_key(|bit| (bit.register_bit, bit.output_bit));
        if let Some(register) = register_map.get_mut(&register_name) {
            register.output_aliases.push(OutputAlias {
                name: output_name,
                width,
                bits,
            });
            register.output_aliases.sort_by(|a, b| a.name.cmp(&b.name));
        }
    }

    for node in &graph.nodes {
        if node.kind != NodeKind::Cell || !node.seq || is_register_node(node) {
            continue;
        }
        let mut port_indices: HashMap<&str, usize> = HashMap::new();
        let mut seen_port_bits: HashMap<(&str, u32), (usize, usize)> = HashMap::new();
        for edge_idx in &graph.incoming[node.id as usize] {
            let edge = &graph.edges[*edge_idx];
            if edge.control {
                continue;
            }
            let depth = edge_depth(graph, node_depth, *edge_idx);
            let endpoint_index = if let Some(index) = port_indices.get(edge.to_port.as_str()) {
                Some(*index)
            } else if boundaries.len() < MAX_BOUNDARY_ENDPOINTS {
                let index = boundaries.len();
                boundaries.push(BoundaryEndpoint {
                    name: node.name.clone(),
                    node_id: node.id,
                    cell_type: node.cell_type.clone().unwrap_or_default(),
                    port: edge.to_port.clone(),
                    width: 0,
                    src: node.src.clone(),
                    worst_depth: 0,
                    bits: Vec::new(),
                    bits_truncated: false,
                });
                port_indices.insert(edge.to_port.as_str(), index);
                Some(index)
            } else {
                boundaries_truncated = true;
                None
            };

            let port_bit = edge.to_port_bit as usize;
            if let Some(index) = endpoint_index {
                boundaries[index].width = boundaries[index].width.max(port_bit + 1);
                boundaries[index].worst_depth = boundaries[index].worst_depth.max(depth);
                let key = (edge.to_port.as_str(), edge.to_port_bit);
                match seen_port_bits.entry(key) {
                    std::collections::hash_map::Entry::Occupied(stored) => {
                        let (stored_endpoint, stored_bit) = *stored.get();
                        boundaries[stored_endpoint].bits[stored_bit].depth =
                            boundaries[stored_endpoint].bits[stored_bit]
                                .depth
                                .max(depth);
                    }
                    std::collections::hash_map::Entry::Vacant(slot) => {
                        if boundary_bit_count < MAX_BOUNDARY_ENDPOINT_BITS {
                            let stored_bit = boundaries[index].bits.len();
                            boundaries[index].bits.push(EndpointBit {
                                bit: port_bit,
                                node_id: node.id,
                                depth,
                            });
                            slot.insert((index, stored_bit));
                            boundary_bit_count += 1;
                        } else {
                            boundaries[index].bits_truncated = true;
                            boundaries_truncated = true;
                        }
                    }
                }
            }

            if endpoint_index.is_none() || boundary_target_count >= MAX_BOUNDARY_ENDPOINT_BITS {
                endpoint_targets_truncated = true;
                continue;
            }
            targets.push(EndpointTarget {
                endpoint: node.id,
                endpoint_port: edge.to_port.clone(),
                edge: Some(*edge_idx),
                startpoint: endpoint_startpoint_id(
                    graph,
                    node_startpoint,
                    node.id,
                    Some(*edge_idx),
                ),
                depth,
                group: node.name.clone(),
                kind: EndpointKind::Blackbox,
                bit: port_bit,
            });
            boundary_target_count += 1;
        }
    }

    for endpoint in &mut boundaries {
        endpoint
            .bits
            .sort_by_key(|bit| (bit.bit, Reverse(bit.depth)));
        endpoint.bits.dedup_by_key(|bit| bit.bit);
    }
    boundaries.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.node_id.cmp(&b.node_id))
            .then_with(|| a.port.cmp(&b.port))
    });

    (
        EndpointsResponse {
            registers: register_map.into_values().collect(),
            outputs,
            inputs,
            boundaries,
            boundaries_truncated,
        },
        targets,
        endpoint_targets_truncated,
    )
}

fn endpoint_data_edges(
    graph: &Graph,
    node_id: NodeId,
    info: &crate::graph::CellInfo,
    width: usize,
) -> Vec<Option<usize>> {
    let mut data_edges = Vec::new();
    let mut d_edges = Vec::new();
    let mut d_edges_by_net = HashMap::new();
    for edge_idx in &graph.incoming[node_id as usize] {
        let edge = &graph.edges[*edge_idx];
        if edge.control {
            continue;
        }
        data_edges.push(*edge_idx);
        if edge.to_port == "D" {
            d_edges.push(*edge_idx);
            if let Some(bit) = edge.bit {
                d_edges_by_net.entry(bit).or_insert(*edge_idx);
            }
        }
    }

    (0..width)
        .map(|bit_idx| {
            info.d_bits
                .get(bit_idx)
                .and_then(|bit| bit.net())
                .and_then(|bit| d_edges_by_net.get(&bit).copied())
                .or_else(|| d_edges.get(bit_idx).copied())
                .or_else(|| data_edges.get(bit_idx).copied())
        })
        .collect()
}

fn endpoint_startpoint_id(
    graph: &Graph,
    node_startpoint: &[Option<NodeId>],
    endpoint: NodeId,
    edge: Option<usize>,
) -> NodeId {
    let Some(edge_idx) = edge else {
        return endpoint;
    };
    let current = graph.edges[edge_idx].from;
    if is_depth_node(graph, current) && is_depth_output_edge(graph, &graph.edges[edge_idx]) {
        node_startpoint[current as usize].unwrap_or(current)
    } else {
        current
    }
}

fn best_endpoint_edge(
    graph: &Graph,
    node_depth: &[Option<u32>],
    node_id: NodeId,
    port: Option<&str>,
) -> Option<usize> {
    graph.incoming[node_id as usize]
        .iter()
        .copied()
        .filter(|idx| port.is_none_or(|name| graph.edges[*idx].to_port == name))
        .max_by_key(|idx| edge_depth(graph, node_depth, *idx))
}

fn edge_depth(graph: &Graph, node_depth: &[Option<u32>], edge_idx: usize) -> u32 {
    let pred = graph.edges[edge_idx].from;
    if is_depth_node(graph, pred) && is_depth_output_edge(graph, &graph.edges[edge_idx]) {
        node_depth[pred as usize].unwrap_or(0)
    } else {
        0
    }
}

/// Follow a top-level output backwards through unconditional, zero-depth data
/// buffers. Returns the driving register and the register-side net bit only
/// when there is exactly one data predecessor at every step.
fn direct_register_driver(graph: &Graph, output: NodeId) -> Option<(NodeId, Option<u32>)> {
    let mut current = output;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        let mut incoming = graph.incoming[current as usize]
            .iter()
            .copied()
            .filter(|idx| !graph.edges[*idx].control);
        let edge_idx = incoming.next()?;
        if incoming.next().is_some() {
            return None;
        }
        let edge = &graph.edges[edge_idx];
        let driver = graph.nodes.get(edge.from as usize)?;
        if is_register_node(driver) {
            return Some((driver.id, edge.bit));
        }
        let transparent = driver
            .cell_type
            .as_deref()
            .is_some_and(is_transparent_data_buffer);
        if driver.kind != NodeKind::Cell || !transparent {
            return None;
        }
        current = driver.id;
    }
    None
}

fn is_direct_endpoint(graph: &Graph, node_id: NodeId) -> bool {
    graph.nodes.get(node_id as usize).is_some_and(|node| {
        node.seq
            || (node.kind == NodeKind::PortBit
                && matches!(
                    node.port_dir,
                    Some(PortDirection::Output | PortDirection::Inout)
                ))
    })
}

fn control_role(pin: &str) -> ControlRole {
    let upper = pin.to_ascii_uppercase();
    if upper.starts_with("CLK") || upper.ends_with("CLK") {
        return ControlRole::Clock;
    }
    match upper.as_str() {
        "CLK" | "C" => ControlRole::Clock,
        "R" | "RST" | "ARST" | "SRST" | "CLR" | "LSR" => ControlRole::Reset,
        "S" | "SET" | "PRE" | "SR" => ControlRole::Set,
        "E" | "EN" | "CE" | "G" | "GE" => ControlRole::Enable,
        _ => ControlRole::Other,
    }
}

fn is_labeled_control_edge(graph: &Graph, edge: &Edge) -> bool {
    if !edge.control {
        return false;
    }
    match control_role(&edge.to_port) {
        ControlRole::Clock | ControlRole::Reset | ControlRole::Set => true,
        ControlRole::Enable => {
            // A decoded/muxed enable is part of the dataflow feeding a
            // register. Only a direct, high-fanout enable input is global
            // control infrastructure. A latch's enable is its clock-like
            // transparent gate, so preserve its existing control semantics.
            let target_is_latch = graph.nodes[edge.to as usize]
                .cell_type
                .as_deref()
                .is_some_and(is_latch_type);
            graph.signal_fanout(edge) >= 8
                && (target_is_latch || is_simple_control_source(graph, edge.from))
        }
        ControlRole::Other => false,
    }
}

const CONTROL_VIS_UNKNOWN: u8 = 0;
const CONTROL_VIS_VISITING: u8 = 1;
const CONTROL_VIS_HIDDEN: u8 = 2;
const CONTROL_VIS_VISIBLE: u8 = 3;

#[derive(Clone, Copy)]
struct ControlVisibilityFrame {
    id: NodeId,
    next_edge: usize,
    reaches_hidden_control: bool,
}

/// Precompute top-level inputs whose complete routing disappears with
/// `hide_control`. Infrastructure cells are transparent so vendor input
/// buffers do not leave disconnected `clk`/`rst` ports on the schematic.
///
/// The iterative memoized walk visits each shared infrastructure path once.
/// Cycles are conservatively visible: ambiguous cyclic routing must not hide a
/// user-facing port, and the traversal remains stack-safe for deep buffers.
fn pure_hidden_control_ports(graph: &Graph) -> HashSet<NodeId> {
    let mut memo = vec![CONTROL_VIS_UNKNOWN; graph.nodes.len()];
    let mut hidden_ports = HashSet::new();

    for port in &graph.nodes {
        if port.kind != NodeKind::PortBit || port.port_dir != Some(PortDirection::Input) {
            continue;
        }
        if memo[port.id as usize] == CONTROL_VIS_UNKNOWN {
            memo[port.id as usize] = CONTROL_VIS_VISITING;
            let mut stack = vec![ControlVisibilityFrame {
                id: port.id,
                next_edge: 0,
                reaches_hidden_control: false,
            }];
            while let Some(frame) = stack.last_mut() {
                let outgoing = &graph.outgoing[frame.id as usize];
                let Some(&edge_index) = outgoing.get(frame.next_edge) else {
                    let result = frame.reaches_hidden_control;
                    memo[frame.id as usize] = if result {
                        CONTROL_VIS_HIDDEN
                    } else {
                        CONTROL_VIS_VISIBLE
                    };
                    stack.pop();
                    continue;
                };
                let edge = &graph.edges[edge_index];
                if is_labeled_control_edge(graph, edge) {
                    frame.reaches_hidden_control = true;
                    frame.next_edge += 1;
                    continue;
                }
                let next = &graph.nodes[edge.to as usize];
                if next.kind != NodeKind::Cell
                    || !next
                        .cell_type
                        .as_deref()
                        .is_some_and(is_infrastructure_cell)
                {
                    memo[frame.id as usize] = CONTROL_VIS_VISIBLE;
                    stack.pop();
                    continue;
                }
                match memo[edge.to as usize] {
                    CONTROL_VIS_UNKNOWN => {
                        memo[edge.to as usize] = CONTROL_VIS_VISITING;
                        stack.push(ControlVisibilityFrame {
                            id: edge.to,
                            next_edge: 0,
                            reaches_hidden_control: false,
                        });
                    }
                    CONTROL_VIS_HIDDEN => {
                        frame.reaches_hidden_control = true;
                        frame.next_edge += 1;
                    }
                    CONTROL_VIS_VISITING | CONTROL_VIS_VISIBLE => {
                        memo[frame.id as usize] = CONTROL_VIS_VISIBLE;
                        stack.pop();
                    }
                    _ => unreachable!("control visibility memo uses known states"),
                }
            }
        }
        if memo[port.id as usize] == CONTROL_VIS_HIDDEN {
            hidden_ports.insert(port.id);
        }
    }
    hidden_ports
}

fn node_controls(
    graph: &Graph,
    node_id: NodeId,
    examined_edges: &mut usize,
    max_examined_edges: Option<usize>,
) -> (Vec<ControlRef>, bool) {
    let mut controls = Vec::new();
    let mut truncated = false;
    for edge_idx in &graph.incoming[node_id as usize] {
        if let Some(limit) = max_examined_edges {
            if *examined_edges >= limit {
                truncated = true;
                break;
            }
            *examined_edges += 1;
        }
        let edge = &graph.edges[*edge_idx];
        if !is_labeled_control_edge(graph, edge) {
            continue;
        }
        let role = control_role(&edge.to_port);
        let node = &graph.nodes[node_id as usize];
        let cell_type = node.cell_type.as_deref();
        let active_low =
            control_active_low(cell_type, &node.params, role, &edge.to_port, &edge.net_name);
        let generated = matches!(
            role,
            ControlRole::Clock | ControlRole::Reset | ControlRole::Set
        )
        .then(|| !is_simple_control_source(graph, edge.from));
        let fanout = graph.signal_fanout(edge);
        let synchronous = control_synchronous(cell_type, role);
        controls.push(ControlRef {
            role,
            pin: edge.to_port.clone(),
            net_name: edge.net_name.clone(),
            driver_id: edge.from,
            driver_ids: Vec::new(),
            net_count: None,
            fanout,
            active_low,
            synchronous,
            src: graph.nodes[edge.from as usize].src.clone(),
            generated,
        });
    }
    controls.sort_by_key(|control| {
        (
            match control.role {
                ControlRole::Clock => 0,
                ControlRole::Reset => 1,
                ControlRole::Set => 2,
                ControlRole::Enable => 3,
                ControlRole::Other => 4,
            },
            control.net_name.clone(),
        )
    });
    controls.dedup_by(|a, b| {
        a.role == b.role && a.net_name == b.net_name && a.driver_id == b.driver_id
    });
    (controls, truncated)
}

fn control_synchronous(cell_type: Option<&str>, role: ControlRole) -> Option<bool> {
    if !matches!(role, ControlRole::Reset | ControlRole::Set) {
        return None;
    }
    let upper = cell_type?.to_ascii_uppercase();
    if upper.starts_with("$_SDFF")
        || matches!(
            upper.as_str(),
            "$SDFF" | "$SDFFE" | "$SDFFCE" | "FDRE" | "FDRE_1" | "FDSE" | "FDSE_1"
        )
    {
        return Some(true);
    }
    if upper.starts_with("$_DFF_")
        || upper.starts_with("$_DFFE_")
        || upper.starts_with("$_DFFSR_")
        || upper.starts_with("$_DFFSRE_")
        || upper.starts_with("$_ALDFF_")
        || upper.starts_with("$_ALDFFE_")
        || upper.starts_with("$_DLATCH")
        || matches!(
            upper.as_str(),
            "$ADFF"
                | "$ADFFE"
                | "$ALDFF"
                | "$ALDFFE"
                | "$DFFSR"
                | "$DFFSRE"
                | "$ADLATCH"
                | "$DLATCHSR"
                | "FDCE"
                | "FDCE_1"
                | "FDPE"
                | "FDPE_1"
                | "FDCPE"
                | "LDCE"
                | "LDPE"
                | "LDCPE"
        )
    {
        return Some(false);
    }
    None
}

fn control_active_low(
    cell_type: Option<&str>,
    params: &BTreeMap<String, String>,
    role: ControlRole,
    pin: &str,
    net_name: &str,
) -> Option<bool> {
    if let Some(cell_type) = cell_type
        && let Some(encoded) = hard_cell_control_active_low(cell_type, role)
    {
        return Some(encoded);
    }
    if let Some(polarity) = parameter_control_active_low(params, role, pin) {
        return Some(polarity);
    }
    if let Some(polarity) = fixed_primitive_control_active_low(cell_type?, role, pin) {
        return Some(polarity);
    }
    let net = net_name.to_ascii_lowercase();
    (matches!(
        role,
        ControlRole::Reset | ControlRole::Set | ControlRole::Enable
    ) && (net.ends_with("_n") || net.ends_with("_b") || pin.to_ascii_uppercase().ends_with('N')))
    .then_some(true)
}

fn parameter_control_active_low(
    params: &BTreeMap<String, String>,
    role: ControlRole,
    pin: &str,
) -> Option<bool> {
    let upper_pin = pin.to_ascii_uppercase();
    let inverted_key = format!("IS_{upper_pin}_INVERTED");
    if let Some(inverted) = binary_parameter_bool(params.get(&inverted_key)) {
        return Some(inverted);
    }
    let key = match (role, upper_pin.as_str()) {
        (ControlRole::Reset, "ARST") => "ARST_POLARITY",
        (ControlRole::Reset, "SRST") => "SRST_POLARITY",
        (ControlRole::Reset, "CLR") => "CLR_POLARITY",
        (ControlRole::Set, "SET" | "PRE") => "SET_POLARITY",
        (ControlRole::Enable, _) => "EN_POLARITY",
        _ => return None,
    };
    binary_parameter_bool(params.get(key)).map(|active_high| !active_high)
}

fn binary_parameter_bool(value: Option<&String>) -> Option<bool> {
    match value.map(String::as_str) {
        Some("0") => Some(false),
        Some("1") => Some(true),
        _ => None,
    }
}

fn fixed_primitive_control_active_low(
    cell_type: &str,
    role: ControlRole,
    pin: &str,
) -> Option<bool> {
    let cell = cell_type.to_ascii_uppercase();
    let pin = pin.to_ascii_uppercase();
    if role == ControlRole::Clock && pin == "C" {
        if matches!(cell.as_str(), "FDRE_1" | "FDSE_1" | "FDCE_1" | "FDPE_1") {
            return Some(true);
        }
        if matches!(
            cell.as_str(),
            "FDRE" | "FDSE" | "FDCE" | "FDPE" | "FDCPE" | "FDR" | "FDS" | "FDC" | "FDP"
        ) {
            return Some(false);
        }
    }
    let fixed_active_high = matches!(
        (cell.as_str(), role, pin.as_str()),
        (
            "FDRE" | "FDRE_1" | "FDCE" | "FDCE_1" | "FDCPE" | "FDR" | "FDC",
            ControlRole::Reset,
            "R" | "CLR"
        ) | (
            "FDSE" | "FDSE_1" | "FDPE" | "FDPE_1" | "FDCPE" | "FDS" | "FDP",
            ControlRole::Set,
            "S" | "PRE"
        ) | ("LDCE" | "LDCPE", ControlRole::Reset, "CLR")
            | ("LDPE" | "LDCPE", ControlRole::Set, "PRE")
            | (
                "FDRE"
                    | "FDRE_1"
                    | "FDCE"
                    | "FDCE_1"
                    | "FDSE"
                    | "FDSE_1"
                    | "FDPE"
                    | "FDPE_1"
                    | "FDCPE"
                    | "LDCE"
                    | "LDPE"
                    | "LDCPE",
                ControlRole::Enable,
                "CE" | "G" | "GE"
            )
    ) || (cell.starts_with("SB_DFF")
        && ((matches!(role, ControlRole::Reset | ControlRole::Set)
            && matches!(pin.as_str(), "R" | "S"))
            || (role == ControlRole::Enable && pin == "E")));
    fixed_active_high.then_some(false)
}

fn hard_cell_control_active_low(cell_type: &str, role: ControlRole) -> Option<bool> {
    let upper = cell_type.to_ascii_uppercase();
    let inner = upper.strip_prefix("$_")?.strip_suffix('_')?;
    let (family, flags) = inner.split_once('_')?;
    let flags = flags.as_bytes();
    let polarity = match (family, role) {
        (_, ControlRole::Clock) => flags.first(),
        ("DFF", ControlRole::Reset)
        | ("DFFE", ControlRole::Reset)
        | ("SDFF", ControlRole::Reset)
        | ("SDFFE", ControlRole::Reset)
        | ("SDFFCE", ControlRole::Reset)
        | ("DLATCH", ControlRole::Reset) => flags.get(1),
        ("DFFSR" | "DFFSRE" | "DLATCHSR", ControlRole::Set) => flags.get(1),
        ("DFFSR" | "DFFSRE" | "DLATCHSR", ControlRole::Reset) => flags.get(2),
        ("DFFE", ControlRole::Enable) if flags.len() == 2 => flags.get(1),
        ("DFFE", ControlRole::Enable) => flags.get(3),
        ("SDFFE" | "SDFFCE" | "DFFSRE", ControlRole::Enable) => flags.last(),
        ("DLATCH", ControlRole::Enable) => flags.first(),
        _ => None,
    }?;
    match polarity {
        b'N' => Some(true),
        b'P' => Some(false),
        _ => None,
    }
}

fn is_simple_control_source(graph: &Graph, start: NodeId) -> bool {
    let mut current = start;
    let mut visited = HashSet::new();
    loop {
        let node = &graph.nodes[current as usize];
        if node.kind == NodeKind::PortBit
            && matches!(
                node.port_dir,
                Some(PortDirection::Input | PortDirection::Inout)
            )
        {
            return true;
        }
        let transparent = node
            .cell_type
            .as_deref()
            .is_some_and(is_infrastructure_cell);
        if node.kind != NodeKind::Cell || !transparent {
            return false;
        }
        // Direct input ports and ordinary logic return above without ever
        // allocating the cycle guard. Only transparent infrastructure chains
        // need visited-node tracking.
        if !visited.insert(current) {
            return false;
        }
        let mut incoming = graph.incoming[current as usize]
            .iter()
            .map(|idx| graph.edges[*idx].from);
        let Some(next) = incoming.next() else {
            return false;
        };
        if incoming.next().is_some() {
            return false;
        }
        current = next;
    }
}

fn should_hide_edge(graph: &Graph, edge: &Edge, hide_control: bool, hide_const: bool) -> bool {
    (hide_control && is_labeled_control_edge(graph, edge))
        || (hide_const
            && graph
                .nodes
                .get(edge.from as usize)
                .is_some_and(|node| node.kind == NodeKind::Const))
}

fn has_visible_neighbor(
    graph: &Graph,
    id: NodeId,
    dir: ConeDir,
    hide_control: bool,
    hide_const: bool,
    examined_edges: &mut usize,
    max_examined_edges: Option<usize>,
) -> Result<bool, ()> {
    let edges = match dir {
        ConeDir::Fanin => &graph.incoming[id as usize],
        ConeDir::Fanout => &graph.outgoing[id as usize],
    };
    for idx in edges {
        if let Some(limit) = max_examined_edges {
            if *examined_edges >= limit {
                return Err(());
            }
            *examined_edges += 1;
        }
        if !should_hide_edge(graph, &graph.edges[*idx], hide_control, hide_const) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn merge_edges(
    edges: Vec<&Edge>,
    is_labeled_control: impl Fn(&Edge) -> bool,
) -> (Vec<GraphEdge>, bool) {
    let mut merged: BTreeMap<(NodeId, NodeId, String, String), GraphEdge> = BTreeMap::new();
    let mut kept_bit_keys: HashSet<(NodeId, NodeId, &str, &str, u32)> = HashSet::new();
    let mut truncated = false;
    let mut kept_bits = 0usize;
    for edge in edges {
        let labeled_control = is_labeled_control(edge);
        let key = (
            edge.from,
            edge.to,
            edge.from_port.clone(),
            edge.to_port.clone(),
        );
        if !merged.contains_key(&key) && merged.len() == MAX_SUBGRAPH_EDGES {
            truncated = true;
            break;
        }
        let entry = merged.entry(key).or_insert_with(|| GraphEdge {
            from: edge.from,
            to: edge.to,
            from_port: edge.from_port.clone(),
            to_port: edge.to_port.clone(),
            net_name: edge.net_name.clone(),
            bits: Vec::new(),
            control: labeled_control.then_some(true),
            source_boundary_members: Vec::new(),
            target_boundary_members: Vec::new(),
        });
        if let Some(bit) = edge.bit {
            let bit_key = (
                edge.from,
                edge.to,
                edge.from_port.as_str(),
                edge.to_port.as_str(),
                bit,
            );
            if kept_bit_keys.contains(&bit_key) {
                // Duplicate raw occurrences carry no additional payload.
            } else if kept_bits < MAX_SUBGRAPH_EDGE_BITS {
                kept_bit_keys.insert(bit_key);
                entry.bits.push(bit);
                kept_bits += 1;
            } else {
                truncated = true;
            }
        }
        if labeled_control {
            entry.control = Some(true);
        }
    }
    (
        merged
            .into_values()
            .map(|mut edge| {
                edge.bits.sort_unstable();
                edge.bits.dedup();
                edge
            })
            .collect(),
        truncated,
    )
}

fn collapse_infrastructure(graph: &Graph, subgraph: Subgraph) -> ProjectedSubgraph {
    #[derive(Clone, Copy)]
    struct ProjectionFrame<'a> {
        edge: &'a GraphEdge,
        bits: &'a [u32],
        control: bool,
    }

    struct CollapsedEdge {
        edge: GraphEdge,
        boundary_electrical: Option<Box<BoundaryElectricalProvenance>>,
    }

    let hidden: HashSet<NodeId> = subgraph
        .nodes
        .iter()
        .filter_map(|node| {
            let cell_type = graph.nodes[node.node.id as usize].cell_type.as_deref()?;
            if !is_infrastructure_cell(cell_type) {
                return None;
            }
            // Cone roots are normally kept even when infrastructure, so an
            // explicitly requested node never vanishes. But a transparent data
            // buffer (IBUF/OBUF/BUFG) that a source line happens to map to must
            // still collapse when infrastructure is hidden — it bridges cleanly
            // to the real net, and leaving it visible is exactly the "IBUF shows
            // with infrastructure off" bug.
            if node.is_root == Some(true) && !is_transparent_data_buffer(cell_type) {
                return None;
            }
            Some(node.node.id)
        })
        .collect();
    if hidden.is_empty() {
        return subgraph.into();
    }

    let mut outgoing: HashMap<NodeId, Vec<&GraphEdge>> = HashMap::new();
    for edge in &subgraph.edges {
        outgoing.entry(edge.from).or_default().push(edge);
    }

    let mut merged: BTreeMap<(NodeId, NodeId, String, String, String, bool), CollapsedEdge> =
        BTreeMap::new();
    let mut truncated = subgraph.truncated;
    let mut projection_work = 0usize;
    'sources: for edge in subgraph
        .edges
        .iter()
        .filter(|edge| !hidden.contains(&edge.from))
    {
        projection_work += 1;
        if projection_work > MAX_SUBGRAPH_EDGES {
            truncated = true;
            break;
        }
        let mut queue = VecDeque::from([ProjectionFrame {
            edge,
            bits: &edge.bits,
            control: edge.control == Some(true),
        }]);
        let mut seen: HashSet<(NodeId, bool, usize, usize)> = HashSet::new();
        while let Some(current) = queue.pop_front() {
            if !hidden.contains(&current.edge.to) {
                let key = (
                    edge.from,
                    current.edge.to,
                    edge.from_port.clone(),
                    current.edge.to_port.clone(),
                    current.edge.net_name.clone(),
                    current.control,
                );
                if !merged.contains_key(&key) && merged.len() == MAX_SUBGRAPH_EDGES {
                    truncated = true;
                    break 'sources;
                }
                let entry = merged.entry(key).or_insert_with(|| CollapsedEdge {
                    edge: GraphEdge {
                        from: edge.from,
                        to: current.edge.to,
                        from_port: edge.from_port.clone(),
                        to_port: current.edge.to_port.clone(),
                        net_name: current.edge.net_name.clone(),
                        bits: Vec::new(),
                        control: current.control.then_some(true),
                        source_boundary_members: Vec::new(),
                        target_boundary_members: Vec::new(),
                    },
                    boundary_electrical: None,
                });
                entry.edge.bits.extend_from_slice(current.bits);
                if graph.nodes[edge.from as usize].kind == NodeKind::PortBit {
                    entry
                        .boundary_electrical
                        .get_or_insert_with(Default::default)
                        .source_bits
                        .get_or_insert_with(Vec::new)
                        .extend_from_slice(&edge.bits);
                }
                if graph.nodes[current.edge.to as usize].kind == NodeKind::PortBit {
                    entry
                        .boundary_electrical
                        .get_or_insert_with(Default::default)
                        .target_bits
                        .get_or_insert_with(Vec::new)
                        .extend_from_slice(&current.edge.bits);
                }
                continue;
            }
            if !seen.insert((
                current.edge.to,
                current.control,
                current.bits.as_ptr() as usize,
                current.bits.len(),
            )) {
                continue;
            }
            for next in outgoing.get(&current.edge.to).into_iter().flatten() {
                projection_work += 1;
                if projection_work > MAX_SUBGRAPH_EDGES {
                    truncated = true;
                    break 'sources;
                }
                queue.push_back(ProjectionFrame {
                    edge: next,
                    bits: if next.bits.is_empty() {
                        current.bits
                    } else {
                        &next.bits
                    },
                    control: current.control || next.control == Some(true),
                });
            }
        }
    }

    let mut edges = Vec::with_capacity(merged.len());
    let mut boundary_electrical = Vec::with_capacity(merged.len());
    for mut collapsed in merged.into_values() {
        collapsed.edge.bits.sort_unstable();
        collapsed.edge.bits.dedup();
        if let Some(provenance) = collapsed.boundary_electrical.as_deref_mut() {
            if let Some(bits) = &mut provenance.source_bits {
                bits.sort_unstable();
                bits.dedup();
            }
            if let Some(bits) = &mut provenance.target_bits {
                bits.sort_unstable();
                bits.dedup();
            }
        }
        edges.push(collapsed.edge);
        boundary_electrical.push(collapsed.boundary_electrical);
    }

    ProjectedSubgraph::new(
        Subgraph {
            nodes: subgraph
                .nodes
                .into_iter()
                .filter(|node| !hidden.contains(&node.node.id))
                .collect(),
            edges,
            truncated,
        },
        boundary_electrical,
    )
}

fn compare_raw_edges(a: &Edge, b: &Edge) -> Ordering {
    (
        a.from,
        a.to,
        a.from_port.as_str(),
        a.to_port.as_str(),
        a.net_name.as_str(),
        a.control,
        a.bit,
    )
        .cmp(&(
            b.from,
            b.to,
            b.from_port.as_str(),
            b.to_port.as_str(),
            b.net_name.as_str(),
            b.control,
            b.bit,
        ))
}

fn compare_graph_edges(a: &GraphEdge, b: &GraphEdge) -> Ordering {
    (
        a.from,
        a.to,
        a.from_port.as_str(),
        a.to_port.as_str(),
        a.net_name.as_str(),
        a.control,
        a.bits.as_slice(),
    )
        .cmp(&(
            b.from,
            b.to,
            b.from_port.as_str(),
            b.to_port.as_str(),
            b.net_name.as_str(),
            b.control,
            b.bits.as_slice(),
        ))
}

fn cap_subgraph_edges(projected: ProjectedSubgraph) -> ProjectedSubgraph {
    let ProjectedSubgraph {
        mut subgraph,
        boundary_electrical,
    } = projected;
    let mut edges_with_provenance = std::mem::take(&mut subgraph.edges)
        .into_iter()
        .zip(boundary_electrical)
        .collect::<Vec<_>>();
    edges_with_provenance.sort_by(|(left, _), (right, _)| compare_graph_edges(left, right));
    if edges_with_provenance.len() > MAX_SUBGRAPH_EDGES {
        edges_with_provenance.truncate(MAX_SUBGRAPH_EDGES);
        subgraph.truncated = true;
    }
    let mut remaining_bits = MAX_SUBGRAPH_EDGE_BITS;
    for (edge, _) in &mut edges_with_provenance {
        if edge.bits.len() > remaining_bits {
            edge.bits.truncate(remaining_bits);
            subgraph.truncated = true;
        }
        remaining_bits = remaining_bits.saturating_sub(edge.bits.len());
    }
    let (edges, boundary_electrical) = edges_with_provenance.into_iter().unzip();
    subgraph.edges = edges;
    ProjectedSubgraph::new(subgraph, boundary_electrical)
}

fn build_stats(
    graph: &Graph,
    endpoints: &EndpointsResponse,
    endpoint_targets: &[EndpointTarget],
    node_depth: &[Option<u32>],
    estimated_max_delay_ps: Option<f64>,
    estimated_max_delay_breakdown: Option<DelayBreakdownPs>,
) -> Stats {
    let mut cells_by_type = BTreeMap::new();
    let mut cell_categories = CellCategoryCounts::default();
    for node in &graph.nodes {
        if node.kind == NodeKind::Cell {
            let cell_type = node.cell_type.clone().unwrap_or_default();
            *cells_by_type.entry(cell_type.clone()).or_insert(0) += 1;
            if is_register_node(node) {
                cell_categories.registers += 1;
            } else if is_infrastructure_cell(&cell_type) {
                cell_categories.infrastructure += 1;
            } else if is_carry_or_special(&cell_type) {
                cell_categories.carry_special += 1;
            } else {
                cell_categories.logic += 1;
            }
        }
    }
    let num_register_bits = endpoints.registers.iter().map(|group| group.width).sum();
    let num_inputs = endpoints.inputs.iter().map(|group| group.width).sum();
    let num_outputs = graph
        .nodes
        .iter()
        .filter(|node| {
            node.kind == NodeKind::PortBit
                && matches!(
                    node.port_dir,
                    Some(PortDirection::Output | PortDirection::Inout)
                )
        })
        .count();
    let retained_max_depth = endpoint_targets
        .iter()
        .map(|target| target.depth)
        .max()
        .unwrap_or_default();
    let boundary_max_depth = graph
        .nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Cell && node.seq && !is_register_node(node))
        .flat_map(|node| graph.incoming[node.id as usize].iter())
        .filter(|edge_idx| !graph.edges[**edge_idx].control)
        .map(|edge_idx| edge_depth(graph, node_depth, *edge_idx))
        .max()
        .unwrap_or_default();
    let max_depth = retained_max_depth.max(boundary_max_depth);
    let mut depths = DepthSummary::default();
    for target in endpoint_targets {
        let startpoint = node_ref(graph, target.startpoint);
        match classify_path(&startpoint, target.kind) {
            PathClass::InputToRegister => update_max(&mut depths.input_to_register, target.depth),
            PathClass::RegisterToRegister => {
                update_max(&mut depths.register_to_register, target.depth)
            }
            PathClass::RegisterToOutput => update_max(&mut depths.register_to_output, target.depth),
            PathClass::InputToOutput => update_max(&mut depths.input_to_output, target.depth),
            PathClass::Other => {}
        }
    }
    Stats {
        num_cells: cells_by_type.values().sum(),
        cells_by_type,
        num_register_bits,
        num_register_groups: endpoints.registers.len(),
        num_inputs,
        num_outputs,
        max_depth,
        depths,
        cell_categories,
        estimated_delay_ns: estimated_max_delay_ps.map(|ps| ps / 1000.0),
        estimated_delay_breakdown: estimated_max_delay_breakdown.map(DelayBreakdown::from_ps),
    }
}

fn update_max(slot: &mut Option<u32>, value: u32) {
    *slot = Some(slot.map_or(value, |current| current.max(value)));
}

fn is_carry_or_special(cell_type: &str) -> bool {
    matches!(
        cell_type.to_ascii_uppercase().as_str(),
        "CCU2C"
            | "CARRY4"
            | "CARRY8"
            | "SB_CARRY"
            | "XORCY"
            | "MUXCY"
            | "MUXF7"
            | "MUXF8"
            | "MUXF9"
            | "PFUMX"
            | "L6MUX21"
            | "SRL16E"
            | "SRLC32E"
    )
}

fn build_warnings(graph: &Graph, comb_loops: &[NodeId]) -> Vec<String> {
    let mut warnings = Vec::new();
    if !comb_loops.is_empty() {
        let names = comb_loops
            .iter()
            .map(|id| graph.node_ref_name(*id))
            .collect::<Vec<_>>()
            .join(", ");
        warnings.push(format!("combinational loop detected: {names}"));
    }
    for id in &graph.blackboxes {
        let node = &graph.nodes[*id as usize];
        warnings.push(format!(
            "blackbox boundary: {} ({})",
            node.name,
            node.cell_type.clone().unwrap_or_default()
        ));
    }
    warnings
}

fn register_q_name(graph: &Graph, net: u32) -> Option<&str> {
    best_net_alias(graph, net, false)
}

fn visible_net_name(graph: &Graph, net: u32) -> Option<&str> {
    best_net_alias(graph, net, true)
}

fn best_net_alias(graph: &Graph, net: u32, require_visible: bool) -> Option<&str> {
    let aliases = graph.net_aliases.get(&net)?;
    let mut best: Option<&str> = None;
    for candidate in aliases {
        let raw_candidate = candidate.as_str();
        let candidate = raw_candidate
            .strip_prefix("$iopadmap$")
            .filter(|name| !name.is_empty())
            .unwrap_or(raw_candidate);
        if require_visible && is_hidden_name(candidate) {
            continue;
        }
        let candidate_depth = bracket_depth(candidate);
        let replace = best.is_none_or(|current| {
            let current_depth = bracket_depth(current);
            candidate_depth > current_depth
                || (candidate_depth == current_depth && candidate.len() < current.len())
        });
        if replace {
            best = Some(candidate);
        }
    }
    best.or_else(|| {
        graph
            .net_names
            .get(&net)
            .map(String::as_str)
            .filter(|name| !require_visible || !is_hidden_name(name))
    })
}

fn is_hidden_name(name: &str) -> bool {
    name.starts_with('$')
}

/// Recover a collision-free vector identity from a Yosys generated bit name
/// such as `$memory$rdreg[0]$q[7]`. Keep the exact hidden stem for grouping;
/// presentation code may prettify it without weakening identity.
fn hidden_vector_group_name(name: &str) -> Option<String> {
    if !is_hidden_name(name) {
        return None;
    }
    let stem = strip_bit_suffix(name);
    if stem == name {
        return None;
    }
    Some(stem.to_owned())
}

/// Displayed endpoint-group name for a register cell. ABC restructuring and
/// library techmaps (for example xilinx `ff_map.v`) can destroy every RTL name
/// on a flip-flop, so after today's Q-net name the chain falls back through
/// visible Q- and D-net aliases, an output port reached through transparent
/// buffers, a visible instance name, and a design-file src label before a
/// deterministic per-node label. Register rows therefore never render as
/// identical bare cell-type entries.
fn register_group_name(
    graph: &Graph,
    node: &crate::graph::Node,
    info: &crate::graph::CellInfo,
    design_files: &HashSet<&str>,
) -> String {
    let q_name = info
        .q_bits
        .iter()
        .find_map(|bit| bit.net())
        .and_then(|net| register_q_name(graph, net));
    if let Some(name) = q_name
        && !is_hidden_name(name)
    {
        return strip_bit_suffix(name).to_owned();
    }
    for bits in [&info.q_bits, &info.d_bits] {
        if let Some(name) = bits
            .iter()
            .filter_map(|bit| bit.net())
            .find_map(|net| visible_net_name(graph, net))
        {
            return strip_bit_suffix(name).to_owned();
        }
    }
    if let Some(group_name) = q_name.and_then(hidden_vector_group_name) {
        return group_name;
    }
    if let Some(port) = forwarded_output_port(graph, node.id) {
        return port;
    }
    if !is_hidden_name(&node.name) {
        return node.name.clone();
    }
    if let Some(group_name) = hidden_vector_group_name(&node.name) {
        return group_name;
    }
    let cell_type = node.cell_type.as_deref().unwrap_or_default();
    if let Some(label) = node
        .src
        .as_deref()
        .and_then(|src| design_src_label(src, design_files))
    {
        return format!("{cell_type} @ {label}");
    }
    format!("{cell_type}·{}", node.id)
}

/// Follow a register's outputs forward through unconditional data buffers to
/// a top-level output port, mirroring `direct_register_driver`.
fn forwarded_output_port(graph: &Graph, register: NodeId) -> Option<String> {
    let mut queue: VecDeque<NodeId> = VecDeque::from([register]);
    let mut visited: HashSet<NodeId> = HashSet::from([register]);
    while let Some(id) = queue.pop_front() {
        for edge_idx in &graph.outgoing[id as usize] {
            let edge = &graph.edges[*edge_idx];
            let Some(sink) = graph.nodes.get(edge.to as usize) else {
                continue;
            };
            if sink.kind == NodeKind::PortBit
                && matches!(
                    sink.port_dir,
                    Some(PortDirection::Output | PortDirection::Inout)
                )
                && let Some(port) = &sink.port
            {
                return Some(port.clone());
            }
            if sink.kind == NodeKind::Cell
                && sink
                    .cell_type
                    .as_deref()
                    .is_some_and(is_transparent_data_buffer)
                && visited.insert(sink.id)
            {
                queue.push_back(sink.id);
            }
        }
    }
    None
}

/// First src fragment that points at a submitted design file, as `file:line`.
/// Library techmap sources (for example `ff_map.v`) are never design files and
/// would mislabel the endpoint.
fn design_src_label(src: &str, design_files: &HashSet<&str>) -> Option<String> {
    src.split('|').find_map(|loc| {
        let (file, start_line, _) = parse_src_loc(loc)?;
        design_files
            .contains(file.as_str())
            .then(|| format!("{file}:{start_line}"))
    })
}

fn bracket_depth(name: &str) -> usize {
    name.as_bytes().iter().filter(|byte| **byte == b'[').count()
}

fn bit_index_from_name(name: &str) -> Option<usize> {
    name.rsplit_once('[')?.1.strip_suffix(']')?.parse().ok()
}

#[cfg(test)]
mod tests;
