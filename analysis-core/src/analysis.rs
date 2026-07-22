//! Bounded structural analysis and API response projections.

use crate::delay_model::DelayModel;
use crate::graph::{
    Edge, Graph, NodeId, NodeKind, cell_depth_weight, is_addressable_sequential_type,
    is_infrastructure_cell, is_register_type, is_transparent_data_buffer, strip_bit_suffix,
};
use crate::grouping::{GroupId, GroupKind, GroupPartition, GroupingProjection};
use crate::netlist::{PortDirection, YosysModule, YosysNetlist};
use deepsize::DeepSizeOf;
use serde::Serialize;
use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use thiserror::Error;

const PATH_NODE_CAP: usize = 512;
const PATH_RECONSTRUCTION_NODE_BUDGET: usize = 65_536;
pub const MAX_PATH_RESULTS: usize = 8_000;
pub const MAX_SUBGRAPH_NODES: usize = 2_000;
const MAX_FULL_GROUP_MEMBERS: usize = 256;
pub const MAX_SUBGRAPH_EDGES: usize = 10_000;
const MAX_SUBGRAPH_EDGE_BITS: usize = MAX_SUBGRAPH_EDGES;
const MAX_FULL_NETLIST_EDGE_VISITS: usize = MAX_SUBGRAPH_EDGES * 4;
const MAX_BOUNDARY_ENDPOINTS: usize = 10_000;
const MAX_BOUNDARY_ENDPOINT_BITS: usize = 100_000;
const FULL_NETLIST_CONTEXT_NODE_BUDGET: usize = MAX_SUBGRAPH_NODES * 16;
pub(crate) const SOURCE_ROOT_COLLECTION_CAP: usize = MAX_SUBGRAPH_NODES + 1;
const SOURCE_LINE_RESPONSE_CAP: usize = 10_000;
const SOURCE_LINE_RESPONSE_NODE_BUDGET: usize = 20_000;
const SOURCE_RANGE_RESPONSE_CAP: usize = 10_000;
const SOURCE_BIT_RANGE_RESPONSE_CAP: usize = 200;
pub(crate) const SOURCE_RANGE_ASSOCIATION_CAP: usize = 20_000;
pub(crate) const SOURCE_RANGE_INDEX_CAP: usize = SOURCE_RANGE_ASSOCIATION_CAP;
const SOURCE_SPAN_INDEX_CAP: usize = SOURCE_RANGE_ASSOCIATION_CAP;
const SOURCE_PROBE_TARGET_VISIT_CAP: usize = SOURCE_RANGE_ASSOCIATION_CAP;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Subgraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct SourceSelectionOptions {
    pub max_nodes: usize,
    pub hide_control: bool,
    pub hide_const: bool,
    pub group_vectors: bool,
    pub group_memories: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceSelectionRange<'a> {
    pub file: &'a str,
    pub start_line: usize,
    pub end_line: usize,
    pub start_column: Option<usize>,
    pub end_column: Option<usize>,
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
pub struct SourceMapResponse {
    pub files: Vec<String>,
    pub by_line: BTreeMap<String, Vec<u32>>,
    pub ranges: Vec<SourceRangeMapping>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct SourceBitRangesResponse {
    pub ranges: Vec<SourceRangeMapping>,
    pub truncated: bool,
    pub approximate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, DeepSizeOf)]
pub struct SourceRangeMapping {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<usize>,
    pub node_ids: Vec<u32>,
    #[serde(rename = "signalBits", skip_serializing_if = "Vec::is_empty")]
    pub signal_bits: Vec<u32>,
    #[serde(
        rename = "approximateSignalBits",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub approximate_signal_bits: Vec<u32>,
    pub mapping_incomplete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, DeepSizeOf)]
#[serde(rename_all = "lowercase")]
pub enum SourceProbeDirection {
    Fanin,
    Fanout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, DeepSizeOf)]
#[serde(rename_all = "snake_case")]
pub enum SourceProbeHintKind {
    Block,
    OutputPort,
    Procedural,
    Signal,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, DeepSizeOf)]
pub struct SourceProbeHint {
    pub file: String,
    pub start_line: usize,
    pub start_column: Option<usize>,
    pub end_line: usize,
    pub end_column: Option<usize>,
    pub direction: SourceProbeDirection,
    pub kind: SourceProbeHintKind,
}

struct SourceProbeSelection {
    roots: Vec<NodeId>,
    direct_bits: Vec<u32>,
    direct_bits_incomplete: bool,
    direction: Option<ConeDir>,
    local_bidirectional: bool,
    expand_output_register_inputs: bool,
    truncated: bool,
}

#[derive(Debug, Clone, Default, DeepSizeOf)]
struct IntervalIndex {
    intervals: Vec<(usize, usize)>,
    prefix_max_end: Vec<usize>,
}

impl IntervalIndex {
    fn rebuild(&mut self) {
        self.intervals.sort_unstable();
        self.intervals.dedup();
        self.prefix_max_end.clear();
        self.prefix_max_end.reserve(self.intervals.len());
        let mut max_end = 0;
        for (_, end) in &self.intervals {
            max_end = max_end.max(*end);
            self.prefix_max_end.push(max_end);
        }
    }

    fn intersects(&self, start_line: usize, end_line: usize) -> bool {
        let end = self
            .intervals
            .partition_point(|(start, _)| *start <= end_line);
        let start = self.prefix_max_end[..end].partition_point(|max_end| *max_end < start_line);
        self.intervals[start..end]
            .iter()
            .any(|(_, interval_end)| *interval_end >= start_line)
    }
}

#[derive(Debug, Clone, DeepSizeOf)]
pub struct SourceLineIndex {
    files: HashSet<String>,
    lines: HashSet<String>,
    recovered_ranges: BTreeMap<String, IntervalIndex>,
    spans: BTreeMap<String, SourceSpanIndex>,
    span_count: usize,
    incomplete_span_files: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, DeepSizeOf)]
struct SourceSpanInterval {
    start_line: usize,
    start_column: Option<usize>,
    end_line: usize,
    end_column: Option<usize>,
}

#[derive(Debug, Clone, Default, DeepSizeOf)]
struct SourceSpanIndex {
    spans: Vec<SourceSpanInterval>,
    prefix_max_end_line: Vec<usize>,
}

impl SourceSpanIndex {
    fn rebuild(&mut self) {
        self.spans.sort();
        self.spans.dedup();
        self.prefix_max_end_line.clear();
        self.prefix_max_end_line.reserve(self.spans.len());
        let mut max_end_line = 0;
        for span in &self.spans {
            max_end_line = max_end_line.max(span.end_line);
            self.prefix_max_end_line.push(max_end_line);
        }
    }

    fn intersects(
        &self,
        start_line: usize,
        end_line: usize,
        start_column: Option<usize>,
        end_column: Option<usize>,
    ) -> bool {
        let end = self
            .spans
            .partition_point(|span| span.start_line <= end_line);
        let start =
            self.prefix_max_end_line[..end].partition_point(|max_end| *max_end < start_line);
        self.spans[start..end].iter().any(|span| {
            source_coordinates_overlap(
                span.start_line,
                span.start_column,
                span.end_line,
                span.end_column,
                start_line,
                start_column,
                end_line,
                end_column,
            )
        })
    }
}

impl SourceLineIndex {
    pub fn from_module(module: &YosysModule, files: Vec<String>) -> Self {
        Self::from_modules([module], files)
    }

    pub fn from_netlist(netlist: &YosysNetlist, top: &str, files: Vec<String>) -> Self {
        let mut reachable = HashSet::new();
        let mut pending = vec![top];
        while let Some(module_name) = pending.pop() {
            if !reachable.insert(module_name) {
                continue;
            }
            let Some(module) = netlist.modules.get(module_name) else {
                continue;
            };
            for cell in module.cells.values() {
                if let Some((child_name, _)) = netlist.modules.get_key_value(&cell.cell_type) {
                    pending.push(child_name);
                }
            }
        }
        let modules = reachable
            .into_iter()
            .filter_map(|name| netlist.modules.get(name));
        Self::from_modules(modules, files)
    }

    fn from_modules<'a>(
        modules: impl IntoIterator<Item = &'a YosysModule>,
        files: Vec<String>,
    ) -> Self {
        let mut lines = HashSet::new();
        let mut spans = BTreeMap::<String, SourceSpanIndex>::new();
        let mut known_spans = BTreeSet::new();
        let mut span_count = 0usize;
        let mut incomplete_span_files = HashSet::new();
        for module in modules {
            for cell in module.cells.values() {
                let Some(src) = cell.attributes.get("src") else {
                    continue;
                };
                insert_src_lines(src, |file, line| {
                    lines.insert(format!("{file}:{line}"));
                });
                for fragment in src.split('|') {
                    let Some((file, start_line, start_column, end_line, end_column)) =
                        parse_src_span(fragment)
                    else {
                        continue;
                    };
                    let span = SourceSpanInterval {
                        start_line,
                        start_column,
                        end_line,
                        end_column,
                    };
                    if known_spans.contains(&(file.clone(), span.clone())) {
                        continue;
                    }
                    if span_count == SOURCE_SPAN_INDEX_CAP {
                        incomplete_span_files.insert(file);
                        continue;
                    }
                    known_spans.insert((file.clone(), span.clone()));
                    spans.entry(file).or_default().spans.push(span);
                    span_count += 1;
                }
            }
        }
        for index in spans.values_mut() {
            index.rebuild();
        }
        Self {
            files: files.into_iter().collect(),
            lines,
            recovered_ranges: BTreeMap::new(),
            spans,
            span_count,
            incomplete_span_files,
        }
    }

    fn span_mapping_incomplete(&self, file: &str) -> bool {
        self.incomplete_span_files.contains(file)
    }

    pub fn contains_range(&self, file: &str, start_line: usize, end_line: usize) -> Option<bool> {
        self.contains_span(file, start_line, end_line, None, None)
    }

    pub fn contains_span(
        &self,
        file: &str,
        start_line: usize,
        end_line: usize,
        start_column: Option<usize>,
        end_column: Option<usize>,
    ) -> Option<bool> {
        if !self.files.contains(file) {
            return None;
        }
        if start_column.is_some() {
            return Some(self.spans.get(file).is_some_and(|index| {
                index.intersects(start_line, end_line, start_column, end_column)
            }));
        }
        Some(
            (start_line..=end_line).any(|line| self.lines.contains(&format!("{file}:{line}")))
                || self
                    .recovered_ranges
                    .get(file)
                    .is_some_and(|index| index.intersects(start_line, end_line)),
        )
    }

    pub fn extend_ranges<'a>(&mut self, ranges: impl IntoIterator<Item = &'a SourceRangeMapping>) {
        let mut known_spans = self
            .spans
            .iter()
            .flat_map(|(file, index)| index.spans.iter().cloned().map(|span| (file.clone(), span)))
            .collect::<BTreeSet<_>>();
        for range in ranges {
            self.recovered_ranges
                .entry(range.file.clone())
                .or_default()
                .intervals
                .push((range.start_line, range.end_line));
            let span = SourceSpanInterval {
                start_line: range.start_line,
                start_column: range.start_column,
                end_line: range.end_line,
                end_column: range.end_column,
            };
            if !known_spans.insert((range.file.clone(), span.clone())) {
                continue;
            }
            if self.span_count == SOURCE_SPAN_INDEX_CAP {
                self.incomplete_span_files.insert(range.file.clone());
            } else {
                self.spans
                    .entry(range.file.clone())
                    .or_default()
                    .spans
                    .push(span);
                self.span_count += 1;
            }
        }
        for index in self.recovered_ranges.values_mut() {
            index.rebuild();
        }
        for index in self.spans.values_mut() {
            index.rebuild();
        }
    }
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
    pub node_depth: Vec<Option<u32>>,
    node_delay: Vec<f64>,
    depth_path_delay: Vec<f64>,
    pub best_pred: Vec<Option<usize>>,
    delay_pred: Vec<Option<usize>>,
    delay_startpoint: Vec<Option<NodeId>>,
    pub comb_loops: Vec<NodeId>,
    comb_loop_set: HashSet<NodeId>,
    pub endpoints: EndpointsResponse,
    endpoint_targets: Vec<EndpointTarget>,
    endpoint_targets_truncated: bool,
    source_map: SourceMapResponse,
    source_ranges: BTreeMap<String, SourceRangeIndex>,
    source_probe_hints: BTreeMap<String, SourceProbeHintIndex>,
    synthetic_src: HashMap<NodeId, BTreeSet<String>>,
    procedural_targets: BTreeMap<String, BTreeMap<usize, Vec<NodeId>>>,
    has_control_output: Vec<bool>,
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

#[derive(Debug, Clone, Default, DeepSizeOf)]
struct SourceRangeIndex {
    ranges: Vec<SourceRangeMapping>,
    prefix_max_end: Vec<usize>,
}

#[derive(Debug, Clone, Default, DeepSizeOf)]
struct SourceProbeHintIndex {
    hints: Vec<SourceProbeHint>,
    prefix_max_end: Vec<usize>,
}

impl SourceProbeHintIndex {
    fn rebuild(&mut self) {
        self.hints.sort();
        self.hints.dedup();
        self.prefix_max_end.clear();
        self.prefix_max_end.reserve(self.hints.len());
        let mut max_end = 0;
        for hint in &self.hints {
            max_end = max_end.max(hint.end_line);
            self.prefix_max_end.push(max_end);
        }
    }

    fn overlapping(&self, start_line: usize, end_line: usize) -> &[SourceProbeHint] {
        let end = self
            .hints
            .partition_point(|hint| hint.start_line <= end_line);
        let start = self.prefix_max_end[..end].partition_point(|max_end| *max_end < start_line);
        &self.hints[start..end]
    }
}

impl SourceRangeIndex {
    fn rebuild(&mut self) {
        self.ranges.sort();
        self.ranges.dedup();
        self.prefix_max_end.clear();
        self.prefix_max_end.reserve(self.ranges.len());
        let mut max_end = 0;
        for range in &self.ranges {
            max_end = max_end.max(range.end_line);
            self.prefix_max_end.push(max_end);
        }
    }

    fn overlapping(&self, start_line: usize, end_line: usize) -> &[SourceRangeMapping] {
        let end = self
            .ranges
            .partition_point(|range| range.start_line <= end_line);
        let start = self.prefix_max_end[..end].partition_point(|max_end| *max_end < start_line);
        &self.ranges[start..end]
    }
}

fn matching_source_ranges(
    index: &SourceRangeIndex,
    start_line: usize,
    end_line: usize,
    start_column: Option<usize>,
    end_column: Option<usize>,
) -> Vec<&SourceRangeMapping> {
    let candidates = index.overlapping(start_line, end_line);
    candidates
        .iter()
        .filter(|range| source_spans_overlap(range, start_line, end_line, start_column, end_column))
        .collect::<Vec<_>>()
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
        let source_map = build_source_map(graph, source_files);
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
            source_map,
            source_ranges: BTreeMap::new(),
            source_probe_hints: BTreeMap::new(),
            synthetic_src: HashMap::new(),
            procedural_targets: BTreeMap::new(),
            has_control_output,
            stats,
            warnings,
            delay_model: *model,
        }
    }

    /// Install per-line procedural assignment targets recovered from the
    /// submitted sources for source-selection queries.
    pub fn set_procedural_targets(&mut self, targets: HashMap<(String, usize), Vec<NodeId>>) {
        for ((file, line), ids) in targets {
            self.procedural_targets
                .entry(file)
                .or_default()
                .insert(line, ids);
        }
    }

    pub(crate) fn set_source_probe_hints(&mut self, hints: Vec<SourceProbeHint>) {
        for hint in hints {
            self.source_probe_hints
                .entry(hint.file.clone())
                .or_default()
                .hints
                .push(hint);
        }
        for index in self.source_probe_hints.values_mut() {
            index.rebuild();
        }
    }

    pub fn endpoints(&self) -> &EndpointsResponse {
        &self.endpoints
    }

    pub fn stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }

    pub fn source_map(&self) -> SourceMapResponse {
        let mut response = SourceMapResponse {
            files: self.source_map.files.clone(),
            by_line: BTreeMap::new(),
            ranges: Vec::new(),
            truncated: self.source_map.truncated,
        };
        let mut line_node_budget = SOURCE_LINE_RESPONSE_NODE_BUDGET;
        let mut lines = self.source_map.by_line.iter().peekable();
        while let Some((location, ids)) = lines.next() {
            if response.by_line.len() == SOURCE_LINE_RESPONSE_CAP {
                response.truncated = true;
                break;
            }
            if !ids.is_empty() && line_node_budget == 0 {
                response.truncated = true;
                break;
            }
            if ids.len() > line_node_budget {
                response.by_line.insert(
                    location.clone(),
                    ids.iter().take(line_node_budget).copied().collect(),
                );
                response.truncated = true;
                break;
            }
            line_node_budget -= ids.len();
            response.by_line.insert(location.clone(), ids.clone());
            if line_node_budget == 0 && lines.peek().is_some() {
                response.truncated = true;
                break;
            }
        }

        let mut node_budget = SOURCE_RANGE_ASSOCIATION_CAP;
        let mut ranges = self
            .source_ranges
            .values()
            .flat_map(|index| index.ranges.iter())
            .peekable();
        while let Some(range) = ranges.next() {
            if response.ranges.len() == SOURCE_RANGE_RESPONSE_CAP {
                response.truncated = true;
                break;
            }
            if !range.node_ids.is_empty() && node_budget == 0 {
                response.truncated = true;
                break;
            }
            let mut public_range = range.clone();
            if public_range.node_ids.len() > node_budget {
                public_range.node_ids.truncate(node_budget);
                response.ranges.push(public_range);
                response.truncated = true;
                break;
            }
            node_budget -= public_range.node_ids.len();
            response.ranges.push(public_range);
            if node_budget == 0 && ranges.peek().is_some_and(|next| !next.node_ids.is_empty()) {
                response.truncated = true;
                break;
            }
        }
        response
    }

    pub fn source_ranges_for_bits(&self, bits: &[u32]) -> SourceBitRangesResponse {
        let selected = bits
            .iter()
            .take(SOURCE_ROOT_COLLECTION_CAP)
            .copied()
            .collect::<BTreeSet<_>>();
        let mut response = SourceBitRangesResponse {
            ranges: Vec::new(),
            truncated: self.source_map.truncated || bits.len() > SOURCE_ROOT_COLLECTION_CAP,
            approximate: false,
        };
        if selected.is_empty() {
            return response;
        }
        for range in self
            .source_ranges
            .values()
            .flat_map(|index| index.ranges.iter())
        {
            let exact_match = range.signal_bits.iter().any(|bit| selected.contains(bit));
            let approximate_match = range
                .approximate_signal_bits
                .iter()
                .any(|bit| selected.contains(bit));
            if !exact_match && !approximate_match {
                continue;
            }
            if response.ranges.len() == SOURCE_BIT_RANGE_RESPONSE_CAP {
                response.truncated = true;
                break;
            }
            let mut public_range = range.clone();
            response.truncated |= public_range.mapping_incomplete;
            response.approximate |= approximate_match;
            public_range.node_ids.clear();
            public_range.signal_bits.clear();
            public_range.approximate_signal_bits.clear();
            response.ranges.push(public_range);
        }
        response
    }

    pub fn source_selection(
        &self,
        graph: &Graph,
        source_index: &SourceLineIndex,
        grouping: &GroupPartition,
        selection: SourceSelectionRange<'_>,
        options: SourceSelectionOptions,
    ) -> Result<SourceSelectionResult, SourceSelectionError> {
        self.source_selection_with_fallback(graph, source_index, grouping, selection, None, options)
    }

    pub fn source_selection_with_fallback(
        &self,
        graph: &Graph,
        source_index: &SourceLineIndex,
        grouping: &GroupPartition,
        selection: SourceSelectionRange<'_>,
        fallback_columns: Option<(usize, usize)>,
        options: SourceSelectionOptions,
    ) -> Result<SourceSelectionResult, SourceSelectionError> {
        let original_selection = selection;
        let SourceSelectionRange {
            file,
            start_line,
            end_line,
            start_column,
            end_column,
        } = selection;
        if !self.source_map.files.iter().any(|name| name == file) {
            return Err(SourceSelectionError::UnknownFile);
        }
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
        let exact_probe = self
            .source_probe_range(graph, file, start_line, end_line, start_column, end_column)
            .ok_or(SourceSelectionError::UnknownFile)?;
        let exact_mapped = !exact_probe.roots.is_empty() || !exact_probe.direct_bits.is_empty();
        let selection = if exact_mapped {
            selection
        } else {
            self.nearest_source_span(source_index, selection, fallback_columns)
        };
        let use_exact_probe = selection == original_selection;
        let SourceSelectionRange {
            file,
            start_line,
            end_line,
            start_column,
            end_column,
        } = selection;
        let probe = if use_exact_probe {
            exact_probe
        } else {
            self.source_probe_range(graph, file, start_line, end_line, start_column, end_column)
                .ok_or(SourceSelectionError::UnknownFile)?
        };
        let control = probe
            .roots
            .iter()
            .any(|root| self.has_control_output[*root as usize]);
        let cone_options = ConeOptions {
            dir: probe.direction.unwrap_or(ConeDir::Fanin),
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
        let mapping_incomplete = probe.direct_bits_incomplete
            || (start_column.is_some() && source_index.span_mapping_incomplete(file))
            || self
                .source_mapping_incomplete(file, start_line, end_line, start_column, end_column)
                .expect("analysis source indexes contain the requested file");
        let source_seen = (if source_columns_are_authoritative(file) {
            source_index.contains_span(file, start_line, end_line, start_column, end_column)
        } else {
            source_index.contains_range(file, start_line, end_line)
        })
        .ok_or(SourceSelectionError::UnknownFile)?
            || self.source_ranges.get(file).is_some_and(|index| {
                !matching_source_ranges(index, start_line, end_line, start_column, end_column)
                    .is_empty()
            });
        let status = if mapping_incomplete {
            SourceSelectionStatus::MappingIncomplete
        } else if !probe.roots.is_empty() {
            SourceSelectionStatus::Mapped
        } else if source_seen {
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

    fn nearest_source_span<'a>(
        &self,
        source_index: &SourceLineIndex,
        selection: SourceSelectionRange<'a>,
        fallback_columns: Option<(usize, usize)>,
    ) -> SourceSelectionRange<'a> {
        let (Some(caret_column), Some(end_column)) = (selection.start_column, selection.end_column)
        else {
            return selection;
        };
        if selection.start_line != selection.end_line || caret_column != end_column {
            return selection;
        }
        let Some((fallback_start, fallback_end)) = fallback_columns else {
            return selection;
        };
        if fallback_start < 1
            || fallback_end < fallback_start
            || caret_column < fallback_start
            || caret_column > fallback_end
        {
            return selection;
        }
        let Some(index) = self.source_ranges.get(selection.file) else {
            return selection;
        };
        if source_index
            .contains_span(
                selection.file,
                selection.start_line,
                selection.end_line,
                selection.start_column,
                selection.end_column,
            )
            .unwrap_or(false)
            || !matching_source_ranges(
                index,
                selection.start_line,
                selection.end_line,
                selection.start_column,
                selection.end_column,
            )
            .is_empty()
        {
            return selection;
        }
        let nearest = index
            .overlapping(selection.start_line, selection.end_line)
            .iter()
            .filter(|range| {
                range.start_line == selection.start_line
                    && range.end_line == selection.end_line
                    && range.start_column.is_some()
                    && range.end_column.is_some()
                    && range
                        .start_column
                        .is_some_and(|start| start >= fallback_start)
                    && range.end_column.is_some_and(|end| end <= fallback_end)
            })
            .min_by_key(|range| {
                let start = range.start_column.expect("filtered precise source range");
                let end = range.end_column.expect("filtered precise source range");
                let distance = if caret_column < start {
                    start - caret_column
                } else {
                    caret_column.saturating_sub(end)
                };
                (distance, start, end)
            });
        nearest.map_or(selection, |range| SourceSelectionRange {
            file: selection.file,
            start_line: range.start_line,
            end_line: range.end_line,
            start_column: range.start_column,
            end_column: range.end_column,
        })
    }

    fn source_mapping_incomplete(
        &self,
        file: &str,
        start_line: usize,
        end_line: usize,
        start_column: Option<usize>,
        end_column: Option<usize>,
    ) -> Option<bool> {
        if !self.source_map.files.iter().any(|name| name == file) {
            return None;
        }
        Some(
            self.source_map.truncated
                || self.source_ranges.get(file).is_some_and(|index| {
                    matching_source_ranges(index, start_line, end_line, start_column, end_column)
                        .iter()
                        .any(|range| range.mapping_incomplete)
                }),
        )
    }

    fn source_nodes_range(
        &self,
        graph: &Graph,
        file: &str,
        start_line: usize,
        end_line: usize,
        start_column: Option<usize>,
        end_column: Option<usize>,
    ) -> Option<Vec<NodeId>> {
        if !self.source_map.files.iter().any(|name| name == file) {
            return None;
        }
        let overlapping_ranges = self
            .source_ranges
            .get(file)
            .map(|index| {
                matching_source_ranges(index, start_line, end_line, start_column, end_column)
            })
            .unwrap_or_default();
        let mut ids = BTreeSet::new();
        let precise_mapping_lines = start_column
            .map(|_| {
                overlapping_ranges
                    .iter()
                    .filter(|range| range.start_column.is_some())
                    .flat_map(|range| {
                        range.start_line.max(start_line)..=range.end_line.min(end_line)
                    })
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        'collect: {
            for line in start_line..=end_line {
                if precise_mapping_lines.contains(&line) {
                    continue;
                }
                if let Some(line_ids) = self.source_map.by_line.get(&format!("{file}:{line}")) {
                    for id in line_ids {
                        if start_column.is_some()
                            && source_columns_are_authoritative(file)
                            && !node_source_overlaps(
                                graph,
                                *id,
                                file,
                                start_line,
                                end_line,
                                start_column,
                                end_column,
                            )
                        {
                            continue;
                        }
                        if insert_bounded_node(&mut ids, *id) {
                            break 'collect;
                        }
                    }
                }
            }
            for range in overlapping_ranges {
                for id in &range.node_ids {
                    if insert_bounded_node(&mut ids, *id) {
                        break 'collect;
                    }
                }
            }
        }
        let roots: Vec<NodeId> = ids.into_iter().collect();
        Some(self.narrow_to_assignment_targets(
            graph,
            SourceSelectionRange {
                file,
                start_line,
                end_line,
                start_column,
                end_column,
            },
            roots,
        ))
    }

    fn source_probe_range(
        &self,
        graph: &Graph,
        file: &str,
        start_line: usize,
        end_line: usize,
        start_column: Option<usize>,
        end_column: Option<usize>,
    ) -> Option<SourceProbeSelection> {
        let default_roots =
            self.source_nodes_range(graph, file, start_line, end_line, start_column, end_column)?;
        let mut direct_bits = BTreeSet::new();
        let mut direct_bits_incomplete = false;
        if let Some(index) = self.source_ranges.get(file) {
            for range in
                matching_source_ranges(index, start_line, end_line, start_column, end_column)
            {
                for bit in &range.signal_bits {
                    if !direct_bits.contains(bit) && direct_bits.len() == SOURCE_ROOT_COLLECTION_CAP
                    {
                        direct_bits_incomplete = true;
                        continue;
                    }
                    direct_bits.insert(*bit);
                }
            }
        }
        let direct_bits = direct_bits.into_iter().collect::<Vec<_>>();
        let Some(index) = self.source_probe_hints.get(file) else {
            return Some(SourceProbeSelection {
                roots: default_roots,
                direct_bits,
                direct_bits_incomplete,
                direction: None,
                local_bidirectional: false,
                expand_output_register_inputs: false,
                truncated: false,
            });
        };
        let overlapping: Vec<&SourceProbeHint> = index
            .overlapping(start_line, end_line)
            .iter()
            .filter(|hint| {
                source_coordinates_overlap(
                    hint.start_line,
                    hint.start_column,
                    hint.end_line,
                    hint.end_column,
                    start_line,
                    start_column,
                    end_line,
                    end_column,
                )
            })
            .collect();
        if overlapping.is_empty() {
            return Some(SourceProbeSelection {
                roots: default_roots,
                direct_bits,
                direct_bits_incomplete,
                direction: None,
                local_bidirectional: false,
                expand_output_register_inputs: false,
                truncated: false,
            });
        }
        let selected: Vec<&SourceProbeHint> = if start_line == end_line
            && overlapping
                .iter()
                .any(|hint| hint.kind != SourceProbeHintKind::Block)
        {
            overlapping
                .into_iter()
                .filter(|hint| hint.kind != SourceProbeHintKind::Block)
                .collect()
        } else {
            overlapping
        };

        let mut roots: BTreeSet<NodeId> = default_roots.into_iter().collect();
        if selected
            .iter()
            .all(|hint| hint.kind == SourceProbeHintKind::Block)
        {
            roots.clear();
        }
        let mut target_visits = 0usize;
        let mut truncated = false;
        'targets: for kind in [SourceProbeHintKind::Procedural, SourceProbeHintKind::Block] {
            for hint in selected.iter().filter(|hint| hint.kind == kind) {
                if hint.start_column.is_some() {
                    if let Some(index) = self.source_ranges.get(file) {
                        for range in matching_source_ranges(
                            index,
                            hint.start_line,
                            hint.end_line,
                            hint.start_column,
                            hint.end_column,
                        ) {
                            for id in &range.node_ids {
                                if target_visits == SOURCE_PROBE_TARGET_VISIT_CAP {
                                    truncated = true;
                                    break 'targets;
                                }
                                target_visits += 1;
                                if insert_bounded_node(&mut roots, *id) {
                                    truncated = true;
                                    break 'targets;
                                }
                            }
                        }
                    }
                    continue;
                }
                if let Some(targets) = self.procedural_targets.get(file) {
                    for ids in targets
                        .range(hint.start_line..=hint.end_line)
                        .map(|(_, ids)| ids)
                    {
                        for id in ids {
                            if target_visits == SOURCE_PROBE_TARGET_VISIT_CAP {
                                truncated = true;
                                break 'targets;
                            }
                            target_visits += 1;
                            if insert_bounded_node(&mut roots, *id) {
                                truncated = true;
                                break 'targets;
                            }
                        }
                    }
                }
            }
        }
        if roots.is_empty() {
            roots.extend(self.source_nodes_range(
                graph,
                file,
                start_line,
                end_line,
                start_column,
                end_column,
            )?);
        }
        let has_fanin = selected
            .iter()
            .any(|hint| hint.direction == SourceProbeDirection::Fanin);
        let has_fanout = selected
            .iter()
            .any(|hint| hint.direction == SourceProbeDirection::Fanout);
        let shared_signal_span = selected.first().is_some_and(|first| {
            selected.iter().all(|hint| {
                hint.kind == SourceProbeHintKind::Signal
                    && hint.start_line == first.start_line
                    && hint.start_column == first.start_column
                    && hint.end_line == first.end_line
                    && hint.end_column == first.end_column
            })
        });
        Some(SourceProbeSelection {
            roots: roots.into_iter().collect(),
            direct_bits,
            direct_bits_incomplete,
            direction: match (has_fanin, has_fanout) {
                (true, false) => Some(ConeDir::Fanin),
                (false, true) => Some(ConeDir::Fanout),
                _ => None,
            },
            local_bidirectional: has_fanin && has_fanout && shared_signal_span,
            expand_output_register_inputs: selected
                .iter()
                .any(|hint| hint.kind == SourceProbeHintKind::OutputPort),
            truncated,
        })
    }

    fn narrow_to_assignment_targets(
        &self,
        graph: &Graph,
        selection: SourceSelectionRange<'_>,
        roots: Vec<NodeId>,
    ) -> Vec<NodeId> {
        let SourceSelectionRange {
            file,
            start_line,
            end_line,
            start_column,
            end_column,
        } = selection;
        if roots.is_empty() || self.procedural_targets.is_empty() {
            return roots;
        }
        let block_roots: HashSet<NodeId> = roots
            .iter()
            .copied()
            .filter(|id| self.is_block_attributed(graph, *id, selection))
            .collect();
        if block_roots.is_empty() {
            return roots;
        }
        let overlapping = self
            .source_ranges
            .get(file)
            .map_or(&[][..], |index| index.overlapping(start_line, end_line));
        let precise_targets = start_column.and_then(|_| {
            self.source_ranges.get(file).and_then(|index| {
                let ids =
                    matching_source_ranges(index, start_line, end_line, start_column, end_column)
                        .into_iter()
                        .filter(|range| range.start_column.is_some())
                        .flat_map(|range| range.node_ids.iter().copied())
                        .collect::<HashSet<_>>();
                (!ids.is_empty()).then_some(ids)
            })
        });
        let mut targets = precise_targets.clone().unwrap_or_default();
        for line in start_line..=end_line {
            let line_targets = precise_targets
                .is_none()
                .then(|| {
                    self.procedural_targets
                        .get(file)
                        .and_then(|targets| targets.get(&line))
                })
                .flatten();
            if let Some(ids) = line_targets {
                targets.extend(ids.iter().copied());
            }
            let contributed = self
                .source_map
                .by_line
                .get(&format!("{file}:{line}"))
                .is_some_and(|ids| ids.iter().any(|id| block_roots.contains(id)))
                || overlapping.iter().any(|range| {
                    range.start_line <= line
                        && line <= range.end_line
                        && range.node_ids.iter().any(|id| block_roots.contains(id))
                });
            if precise_targets.is_none()
                && contributed
                && line_targets.is_none_or(|ids| ids.is_empty())
            {
                return roots;
            }
        }
        if targets.is_empty() {
            return roots;
        }
        let narrowed: Vec<NodeId> = roots
            .iter()
            .copied()
            .filter(|id| targets.contains(id) || !block_roots.contains(id))
            .collect();
        if narrowed.is_empty() { roots } else { narrowed }
    }

    fn is_block_attributed(
        &self,
        graph: &Graph,
        id: NodeId,
        selection: SourceSelectionRange<'_>,
    ) -> bool {
        let SourceSelectionRange {
            file,
            start_line,
            end_line,
            start_column,
            end_column,
        } = selection;
        let spans_outside = |src: &str| {
            src.split('|').any(|location| {
                parse_src_span(location).is_some_and(
                    |(span_file, span_start, span_start_column, span_end, span_end_column)| {
                        if span_file != file
                            || !source_coordinates_overlap(
                                span_start,
                                span_start_column,
                                span_end,
                                span_end_column,
                                start_line,
                                start_column,
                                end_line,
                                end_column,
                            )
                        {
                            return false;
                        }
                        match (span_start_column, span_end_column, start_column, end_column) {
                            (
                                Some(span_start_column),
                                Some(span_end_column),
                                Some(start_column),
                                Some(end_column),
                            ) => {
                                (span_start, span_start_column) < (start_line, start_column)
                                    || (span_end, span_end_column) > (end_line, end_column)
                            }
                            _ => span_start < start_line || span_end > end_line,
                        }
                    },
                )
            })
        };
        graph
            .nodes
            .get(id as usize)
            .and_then(|node| node.src.as_deref())
            .is_some_and(spans_outside)
            || self
                .synthetic_src
                .get(&id)
                .is_some_and(|sources| sources.iter().any(|src| spans_outside(src)))
    }

    pub fn extend_source_ranges(&mut self, ranges: Vec<SourceRangeMapping>, truncated: bool) {
        let indexed_ranges = self
            .source_ranges
            .values()
            .map(|index| index.ranges.len())
            .sum::<usize>();
        let remaining = SOURCE_RANGE_INDEX_CAP.saturating_sub(indexed_ranges);
        let ranges_omitted = ranges.len() > remaining;
        for range in ranges.into_iter().take(remaining) {
            let source = format_source_range(&range);
            for root in &range.node_ids {
                self.synthetic_src
                    .entry(*root)
                    .or_default()
                    .insert(source.clone());
            }
            self.source_ranges
                .entry(range.file.clone())
                .or_default()
                .ranges
                .push(range);
        }
        for index in self.source_ranges.values_mut() {
            index.rebuild();
        }
        self.source_map.truncated |= truncated || ranges_omitted;
    }

    pub fn node_ref(&self, graph: &Graph, id: NodeId) -> NodeRef {
        let mut reference = node_ref(graph, id);
        let Some(synthetic) = self.synthetic_src.get(&id) else {
            return reference;
        };
        let mut sources: BTreeSet<String> = reference
            .src
            .as_deref()
            .into_iter()
            .flat_map(|src| src.split('|'))
            .map(str::to_owned)
            .collect();
        sources.extend(synthetic.iter().cloned());
        reference.src =
            (!sources.is_empty()).then(|| sources.into_iter().collect::<Vec<_>>().join("|"));
        reference
    }

    /// Longest structural paths, delay-costed with the design's synth-time model.
    pub fn paths(&self, graph: &Graph, limit: usize, to: Option<NodeId>) -> PathsResponse {
        self.paths_with_model(graph, &self.delay_model, limit, to, PathSort::Depth)
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

    /// Like [`Analysis::paths`], but delay-costs each path with a caller-supplied
    /// model (e.g. a client's retune), so per-path delays track the overview.
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

    pub fn cone(
        &self,
        graph: &Graph,
        root: NodeId,
        options: ConeOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Option<Subgraph> {
        self.multi_root_cone(graph, &[root], options, grouping)
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

    pub fn envelope(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[ConeDir::Fanin, ConeDir::Fanout],
            options,
            grouping,
            SubgraphWorkLimits::for_public_projection(),
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

        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &included_roots,
                boundary_nodes: &boundary_nodes,
                truncated,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: work_limits
                    .max_examined_edges
                    .map(|limit| limit.saturating_sub(examined_edges)),
            },
        );
        Some(match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph,
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
                boundary_nodes: &empty,
                truncated,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: Some(
                    MAX_FULL_NETLIST_EDGE_VISITS.saturating_sub(examined_edges),
                ),
            },
        );
        match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph,
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

        let empty = HashSet::new();
        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                boundary_nodes: &empty,
                truncated,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: Some(
                    MAX_FULL_NETLIST_EDGE_VISITS.saturating_sub(examined_edges),
                ),
            },
        );
        match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph,
        }
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
    ) -> Subgraph {
        let mut node_ids: Vec<NodeId> = seen.iter().copied().collect();
        node_ids.sort_unstable();
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
                }
            })
            .collect();
        let mut edges: Vec<&Edge> = edge_set
            .iter()
            .filter_map(|idx| graph.edges.get(*idx))
            .filter(|edge| seen.contains(&edge.from) && seen.contains(&edge.to))
            .collect();
        edges.sort_by(|a, b| compare_raw_edges(a, b));
        let (edges, edges_truncated) = merge_edges(edges);
        let subgraph = Subgraph {
            nodes,
            edges,
            truncated: projection.truncated || edges_truncated || controls_truncated,
        };
        let projected = if projection.show_infrastructure {
            subgraph
        } else {
            collapse_infrastructure(graph, subgraph)
        };
        cap_subgraph_edges(projected)
    }
}

struct SubgraphProjection<'a> {
    roots: &'a HashSet<NodeId>,
    boundary_nodes: &'a HashSet<NodeId>,
    truncated: bool,
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
    subgraph: Subgraph,
    grouping: GroupingProjection<'_>,
) -> Subgraph {
    const MAX_MERGED_SRC_FRAGMENTS: usize = 8;
    let base = graph.nodes.len() as u32;

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
    for node in subgraph.nodes {
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
        nodes.push(GraphNode {
            node: NodeRef {
                id: base + group_id,
                kind: if is_port {
                    ApiNodeKind::Port
                } else {
                    ApiNodeKind::Cell
                },
                name: group.label.clone(),
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
        });
    }
    nodes.sort_by_key(|node| node.node.id);

    // Re-merge edges across unit ids: intra-group edges (same unit both ends)
    // vanish; parallel bus edges collapse to one carrying every bit.
    let mut merged: BTreeMap<(u32, u32, String, String), GraphEdge> = BTreeMap::new();
    for edge in subgraph.edges {
        let from = unit_id(Some(grouping), base, edge.from);
        let to = unit_id(Some(grouping), base, edge.to);
        if from == to {
            continue;
        }
        let key = (from, to, edge.from_port.clone(), edge.to_port.clone());
        let entry = merged.entry(key).or_insert_with(|| GraphEdge {
            from,
            to,
            from_port: edge.from_port.clone(),
            to_port: edge.to_port.clone(),
            // A bus edge carries the vector net, not one bit's `name[k]`.
            net_name: strip_bit_suffix(&edge.net_name).to_owned(),
            bits: Vec::new(),
            control: edge.control,
        });
        entry.bits.extend_from_slice(&edge.bits);
        if edge.control == Some(true) {
            entry.control = Some(true);
        }
    }
    let edges = merged
        .into_values()
        .map(|mut edge| {
            edge.bits.sort_unstable();
            edge.bits.dedup();
            edge
        })
        .collect();

    Subgraph {
        nodes,
        edges,
        truncated: subgraph.truncated || src_truncated,
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
        ControlRole::Enable => graph.signal_fanout(edge) >= 8,
        ControlRole::Other => false,
    }
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
    while visited.insert(current) {
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
    false
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

fn merge_edges(edges: Vec<&Edge>) -> (Vec<GraphEdge>, bool) {
    let mut merged: BTreeMap<(NodeId, NodeId, String, String), GraphEdge> = BTreeMap::new();
    let mut kept_bit_keys: HashSet<(NodeId, NodeId, &str, &str, u32)> = HashSet::new();
    let mut truncated = false;
    let mut kept_bits = 0usize;
    for edge in edges {
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
            control: edge.control.then_some(true),
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
        if edge.control {
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

fn collapse_infrastructure(graph: &Graph, subgraph: Subgraph) -> Subgraph {
    #[derive(Clone, Copy)]
    struct ProjectionFrame<'a> {
        edge: &'a GraphEdge,
        bits: &'a [u32],
        control: bool,
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
        return subgraph;
    }

    let mut outgoing: HashMap<NodeId, Vec<&GraphEdge>> = HashMap::new();
    for edge in &subgraph.edges {
        outgoing.entry(edge.from).or_default().push(edge);
    }

    let mut merged: BTreeMap<(NodeId, NodeId, String, String, String, bool), GraphEdge> =
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
                let entry = merged.entry(key).or_insert_with(|| GraphEdge {
                    from: edge.from,
                    to: current.edge.to,
                    from_port: edge.from_port.clone(),
                    to_port: current.edge.to_port.clone(),
                    net_name: current.edge.net_name.clone(),
                    bits: Vec::new(),
                    control: current.control.then_some(true),
                });
                entry.bits.extend_from_slice(current.bits);
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

    Subgraph {
        nodes: subgraph
            .nodes
            .into_iter()
            .filter(|node| !hidden.contains(&node.node.id))
            .collect(),
        edges: merged
            .into_values()
            .map(|mut edge| {
                edge.bits.sort_unstable();
                edge.bits.dedup();
                edge
            })
            .collect(),
        truncated,
    }
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

fn cap_subgraph_edges(mut subgraph: Subgraph) -> Subgraph {
    subgraph.edges.sort_by(compare_graph_edges);
    if subgraph.edges.len() > MAX_SUBGRAPH_EDGES {
        subgraph.edges.truncate(MAX_SUBGRAPH_EDGES);
        subgraph.truncated = true;
    }
    let mut remaining_bits = MAX_SUBGRAPH_EDGE_BITS;
    for edge in &mut subgraph.edges {
        if edge.bits.len() > remaining_bits {
            edge.bits.truncate(remaining_bits);
            subgraph.truncated = true;
        }
        remaining_bits = remaining_bits.saturating_sub(edge.bits.len());
    }
    subgraph
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

fn build_source_map(graph: &Graph, files: Vec<String>) -> SourceMapResponse {
    let mut by_line: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    let mut truncated = false;
    for node in &graph.nodes {
        let Some(src) = &node.src else {
            continue;
        };
        insert_src_lines(src, |file, line| {
            let ids = by_line.entry(format!("{file}:{line}")).or_default();
            if ids.last() == Some(&node.id) {
                return;
            }
            if ids.len() < SOURCE_ROOT_COLLECTION_CAP {
                ids.push(node.id);
            } else {
                truncated = true;
            }
        });
    }
    for ids in by_line.values_mut() {
        ids.sort_unstable();
        ids.dedup();
        ids.truncate(SOURCE_ROOT_COLLECTION_CAP);
    }
    SourceMapResponse {
        files,
        by_line,
        ranges: Vec::new(),
        truncated,
    }
}

fn format_source_range(range: &SourceRangeMapping) -> String {
    match (range.start_column, range.end_column) {
        (Some(start_column), Some(end_column)) => format!(
            "{}:{}.{}-{}.{}",
            range.file, range.start_line, start_column, range.end_line, end_column
        ),
        _ => format!("{}:{}-{}", range.file, range.start_line, range.end_line),
    }
}

fn source_spans_overlap(
    range: &SourceRangeMapping,
    start_line: usize,
    end_line: usize,
    start_column: Option<usize>,
    end_column: Option<usize>,
) -> bool {
    source_coordinates_overlap(
        range.start_line,
        range.start_column,
        range.end_line,
        range.end_column,
        start_line,
        start_column,
        end_line,
        end_column,
    )
}

fn source_columns_are_authoritative(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    !lower.ends_with(".vhd") && !lower.ends_with(".vhdl")
}

#[allow(clippy::too_many_arguments)]
fn node_source_overlaps(
    graph: &Graph,
    id: NodeId,
    file: &str,
    start_line: usize,
    end_line: usize,
    start_column: Option<usize>,
    end_column: Option<usize>,
) -> bool {
    graph.nodes[id as usize]
        .src
        .as_deref()
        .into_iter()
        .flat_map(|src| src.split('|'))
        .filter_map(parse_src_span)
        .any(
            |(span_file, span_start_line, span_start_column, span_end_line, span_end_column)| {
                span_file == file
                    && source_coordinates_overlap(
                        span_start_line,
                        span_start_column,
                        span_end_line,
                        span_end_column,
                        start_line,
                        start_column,
                        end_line,
                        end_column,
                    )
            },
        )
}

#[allow(clippy::too_many_arguments)]
fn source_coordinates_overlap(
    range_start_line: usize,
    range_start_column: Option<usize>,
    range_end_line: usize,
    range_end_column: Option<usize>,
    start_line: usize,
    start_column: Option<usize>,
    end_line: usize,
    end_column: Option<usize>,
) -> bool {
    if range_end_line < start_line || range_start_line > end_line {
        return false;
    }
    let (Some(range_start_column), Some(range_end_column)) = (range_start_column, range_end_column)
    else {
        return true;
    };
    let (Some(start_column), Some(end_column)) = (start_column, end_column) else {
        return true;
    };
    (range_start_line, range_start_column) <= (end_line, end_column)
        && (start_line, start_column) <= (range_end_line, range_end_column)
}

fn insert_bounded_node(ids: &mut BTreeSet<NodeId>, id: NodeId) -> bool {
    if ids.len() < SOURCE_ROOT_COLLECTION_CAP {
        ids.insert(id);
    }
    ids.len() >= SOURCE_ROOT_COLLECTION_CAP
}

fn insert_src_lines(mut src: &str, mut insert: impl FnMut(&str, usize)) {
    while !src.is_empty() {
        let (loc, rest) = src
            .split_once('|')
            .map_or((src, ""), |(loc, rest)| (loc, rest));
        if let Some((file, start, end)) = parse_src_loc(loc) {
            for line in start..=end.min(start + 199) {
                insert(&file, line);
            }
        }
        src = rest;
    }
}

pub(crate) fn parse_src_loc(loc: &str) -> Option<(String, usize, usize)> {
    let (file, start_line, _, end_line, _) = parse_src_span(loc)?;
    Some((file, start_line, end_line))
}

pub(crate) type ParsedSourceSpan = (String, usize, Option<usize>, usize, Option<usize>);

pub(crate) fn parse_src_span(loc: &str) -> Option<ParsedSourceSpan> {
    let trimmed = loc.trim();
    let (file, rest) = trimmed.rsplit_once(':')?;
    let (start, end) = rest.split_once('-').map_or((rest, rest), |(a, b)| (a, b));
    let parse_point = |point: &str| {
        let (line, column) = point
            .split_once('.')
            .map_or((point, None), |(line, column)| (line, Some(column)));
        Some((line.parse().ok()?, column.map(str::parse).transpose().ok()?))
    };
    let (start_line, start_column) = parse_point(start)?;
    let (end_line, end_column) = parse_point(end)?;
    let file_name = std::path::Path::new(file)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file)
        .to_owned();
    let (end_line, end_column) = if end_line < start_line {
        (start_line, start_column)
    } else {
        (end_line, end_column)
    };
    Some((file_name, start_line, start_column, end_line, end_column))
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
mod tests {
    use super::*;
    use crate::graph::{CellInfo, Edge, Graph, Node, NodeKind};
    use crate::grouping::{Group, GroupKind};
    use crate::netlist::{PortDirection, YosysBit, YosysModule, parse_str, select_top};
    use std::time::Instant;

    type EdgeSignature = (
        NodeId,
        NodeId,
        String,
        String,
        String,
        Vec<u32>,
        Option<bool>,
    );

    fn full_options(
        max_nodes: usize,
        show_infrastructure: bool,
        hide_control: bool,
        hide_const: bool,
        priority_roots: &[NodeId],
    ) -> FullNetlistOptions<'_> {
        FullNetlistOptions {
            max_nodes,
            show_infrastructure,
            hide_control,
            hide_const,
            priority_roots,
        }
    }

    fn fixture(name: &str) -> (Graph, Analysis) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name);
        let json = std::fs::read_to_string(path).unwrap();
        let netlist = parse_str(&json).unwrap();
        let (top, module) = select_top(&netlist, None).unwrap();
        let graph = Graph::from_netlist(&netlist, top, module).unwrap();
        let analysis = Analysis::new(&graph, vec!["fixture.sv".to_owned()]);
        (graph, analysis)
    }

    #[test]
    fn depth_dp_counts_three_and_levels() {
        let (_graph, analysis) = fixture("and_chain_rtl.json");
        assert_eq!(analysis.stats.max_depth, 3);
        let paths = analysis.paths(&_graph, 5, None);
        assert_eq!(paths.paths[0].depth, 3);
    }

    #[test]
    fn estimates_a_positive_critical_path_delay() {
        let (graph, analysis) = fixture("and_chain_rtl.json");
        let est = analysis
            .stats
            .estimated_delay_ns
            .expect("a combinational design has a delay estimate");
        // A depth-3 chain: a few cells + fanout nets + capture setup — the rough
        // pre-route figure should be positive and in a sane nanosecond range.
        assert!(est > 0.3 && est < 30.0, "implausible estimate: {est} ns");
        let timing = analysis.estimate_timing(&graph, &DelayModel::default());
        assert_eq!(timing.starts_at_register, Some(false));
        assert_eq!(timing.endpoint_kind, Some(EndpointKind::Output));
    }

    /// The single node of `cell_type` in a fixture, by cell name.
    fn cell_named<'a>(graph: &'a Graph, name: &str) -> &'a Node {
        graph
            .nodes
            .iter()
            .find(|node| node.name == name)
            .unwrap_or_else(|| panic!("fixture has a cell named {name}"))
    }

    #[test]
    fn clock_distribution_is_not_a_data_path() {
        // `synth_xilinx` defaults emit clk -> IBUF -> BUFG -> every FDRE's C
        // pin. Walked as ordinary combinational logic that chain charges a cell
        // delay per buffer and then a register setup, so a shallow sequential
        // design reports its own clock tree as the critical path.
        let (graph, analysis) = fixture("pipe_clock_tree_xilinx.json");

        // The clock buffer and the IBUF feeding it carry a clock, not data.
        let bufg = cell_named(&graph, "$auto$clkbufmap.cc:261:execute$1720");
        assert_eq!(bufg.cell_type.as_deref(), Some("BUFG"));
        assert!(graph.is_clock_network(bufg.id));
        assert!(graph.is_clock_network(cell_named(&graph, "$iopadmap$pipe.clk").id));

        // An IBUF on a *data* port stays a data-path node — the rule is about
        // where a signal goes, not which primitive drives it. `en` and `rst`
        // land on control pins (CE/R) but are still real signals, not clocks.
        for data_port in [
            "$iopadmap$pipe.data_in",
            "$iopadmap$pipe.data_in_7",
            "$iopadmap$pipe.en",
            "$iopadmap$pipe.rst",
        ] {
            let node = cell_named(&graph, data_port);
            assert!(
                !graph.is_clock_network(node.id),
                "{data_port} is not part of the clock network",
            );
        }

        let model = DelayModel::series7();
        let est = analysis.estimate_timing(&graph, &model);
        let bd = est.breakdown.expect("a registered design has a breakdown");
        // The reported path must be a *data* path. Which one is worst depends
        // on the coefficients — a bare FF->FF hop (clk-to-Q + route) or a data
        // input through its IBUF (two routes + one cell) — but the clock chain
        // (IBUF + BUFG + every FF's C pin) must never be walked. The bug
        // charged both clock buffers as logic: logic_ns of 2x cell_ps. A data
        // path through at most the port IBUF can never carry more than one.
        assert!(
            bd.logic_ns <= model.cell_ps / 1000.0 + 1e-9,
            "at most the data-port IBUF is logic, never the IBUF+BUFG clock \
             chain: {} ns",
            bd.logic_ns,
        );
        assert_eq!(bd.setup_ns, model.ff_setup_ps / 1000.0);
        let delay = est.delay_ns.expect("a registered design has an estimate");
        // Exactly the worse of the two real data paths, from the model itself.
        let ff_hop = model.ff_clk_to_q_ps + model.net_delay_ps(1);
        let input_hop = 2.0 * model.net_delay_ps(1) + model.cell_ps;
        let expected = (ff_hop.max(input_hop) + model.ff_setup_ps) / 1000.0;
        assert!(
            (delay - expected).abs() < 1e-9,
            "a data path, not the clock tree: {delay} vs {expected}",
        );
    }

    #[test]
    fn register_to_register_design_is_a_timing_path() {
        // Nothing but 32 FDREs (`-noiopad -noclkbuf`): zero combinational
        // cells. The DP only walks combinational nodes, so this design used to
        // produce no estimate at all where a vendor tool reports a real
        // clk-to-Q + route + setup number. A direct register->register
        // connection is a timing path with zero logic levels.
        let (graph, analysis) = fixture("pipe_registers_only_xilinx.json");
        assert!(
            !graph.nodes.iter().any(|node| graph.is_comb(node.id)),
            "fixture is registers only",
        );

        let model = DelayModel::series7();
        let est = analysis.estimate_timing(&graph, &model);
        let delay = est
            .delay_ns
            .expect("a register-to-register design has an estimate");
        let bd = est.breakdown.expect("and a breakdown");
        assert_eq!(bd.launch_ns, model.ff_clk_to_q_ps / 1000.0);
        assert_eq!(bd.logic_ns, 0.0, "a direct FF->FF hop has no logic levels");
        assert_eq!(bd.net_ns, model.net_delay_ps(1) / 1000.0);
        assert_eq!(bd.setup_ns, model.ff_setup_ps / 1000.0);
        assert_eq!(est.starts_at_register, Some(true));
        assert_eq!(est.endpoint_kind, Some(EndpointKind::Register));
        let expected = (model.ff_clk_to_q_ps + model.net_delay_ps(1) + model.ff_setup_ps) / 1000.0;
        assert!(
            (delay - expected).abs() < 1e-9,
            "launch + net + setup: {delay} vs {expected}"
        );
        // The overview figure agrees with the stats the API serves.
        assert_eq!(analysis.stats.estimated_delay_ns, Some(delay));
        assert_eq!(analysis.stats.max_depth, 0, "no logic levels");
    }

    #[test]
    fn paths_carry_a_per_path_delay_matching_the_overview_worst() {
        let (graph, analysis) = fixture("reg_mux_rtl.json");
        let overall = analysis
            .stats
            .estimated_delay_ns
            .expect("a registered design has a delay estimate");
        let paths = analysis.paths(&graph, 25, None);
        let worst = paths
            .paths
            .iter()
            .filter_map(|p| p.estimated_delay_ns)
            .fold(0.0f64, f64::max);
        // Every reconstructed path is delay-costed, and the slowest one matches
        // the overview's worst-case figure (both use the same model + setup).
        assert!(paths.paths.iter().all(|p| p.estimated_delay_ns.is_some()));
        assert!(worst > 0.0);
        assert!(
            (worst - overall).abs() < 1e-6,
            "worst path {worst} should match overview {overall}",
        );
    }

    #[test]
    fn paths_with_model_retunes_per_path_delays() {
        let (graph, analysis) = fixture("reg_mux_rtl.json");
        let worst = |resp: &PathsResponse| {
            resp.paths
                .iter()
                .filter_map(|p| p.estimated_delay_ns)
                .fold(0.0f64, f64::max)
        };
        let s7 =
            analysis.paths_with_model(&graph, &DelayModel::series7(), 25, None, PathSort::Depth);
        let usp = analysis.paths_with_model(
            &graph,
            &DelayModel::ultrascale_plus(),
            25,
            None,
            PathSort::Depth,
        );
        // A faster model shrinks the per-path delays without changing structure.
        assert_eq!(s7.paths.len(), usp.paths.len());
        assert!(worst(&usp) < worst(&s7), "ultrascale+ should be faster");
    }

    #[test]
    fn asic_gate_prices_flow_through_overview_and_paths() {
        // Reuse the three-cell chain fixture but spell its generic cells as the
        // gates-mode Yosys types this model dispatches. The chain becomes
        // XOR -> AND -> AND, so exact logic timing must be the sum of those
        // three characterized categories everywhere timing is surfaced.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/and_chain_rtl.json");
        let json = std::fs::read_to_string(path).unwrap();
        let mut netlist = parse_str(&json).unwrap();
        let cells = &mut netlist.modules.get_mut("top").unwrap().cells;
        for (cell, cell_type) in cells.values_mut().zip(["$_XOR_", "$_AND_", "$_AND_"]) {
            cell.cell_type = cell_type.to_owned();
        }
        let module = netlist.modules.get("top").unwrap();
        let graph = Graph::from_netlist(&netlist, "top", module).unwrap();

        let mut model = DelayModel::sky130hd();
        model.ff_clk_to_q_ps = 0.0;
        model.ff_setup_ps = 0.0;
        model.net_base_ps = 0.0;
        model.net_per_fanout_ps = 0.0;
        let analysis = Analysis::with_delay_model(&graph, vec!["fixture.sv".to_owned()], &model);
        let expected_ns = (330.5 + 189.2 + 189.2) / 1000.0;

        let breakdown = analysis.stats.estimated_delay_breakdown.unwrap();
        assert!((breakdown.logic_ns - expected_ns).abs() < 1e-9);
        assert_eq!(breakdown.net_ns, 0.0);
        assert_eq!(analysis.stats.estimated_delay_ns, Some(expected_ns));

        let worst_path_delay = |response: &PathsResponse| {
            response
                .paths
                .iter()
                .filter_map(|path| path.estimated_delay_ns)
                .fold(0.0f64, f64::max)
        };
        assert!((worst_path_delay(&analysis.paths(&graph, 25, None)) - expected_ns).abs() < 1e-9);

        // Force the Paths recomputation branch with a custom XOR override and
        // prove it agrees exactly with the Overview estimator for that model.
        let mut retuned = model;
        retuned.gate_ps.as_mut().unwrap().xor = Some(500.0);
        let retuned_overview = analysis.estimate_timing(&graph, &retuned).delay_ns.unwrap();
        let retuned_paths = analysis.paths_with_model(&graph, &retuned, 25, None, PathSort::Depth);
        let retuned_expected_ns = (500.0 + 189.2 + 189.2) / 1000.0;
        assert!((retuned_overview - retuned_expected_ns).abs() < 1e-9);
        assert!((worst_path_delay(&retuned_paths) - retuned_expected_ns).abs() < 1e-9);
    }

    #[test]
    fn delay_sort_reconstructs_and_costs_the_delay_argmax() {
        let graph = divergent_depth_delay_graph();
        let mut model = DelayModel::generic();
        model.lut_ps = 1_000.0;
        model.cell_ps = 1.0;
        model.net_base_ps = 0.0;
        model.net_per_fanout_ps = 0.0;
        let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);

        let depth = analysis.paths_with_model(&graph, &model, 2, None, PathSort::Depth);
        let depth_path = depth
            .paths
            .iter()
            .find(|path| path.endpoint_group == "slow_output")
            .expect("the convergent output is returned");
        assert!(depth_path.nodes.iter().any(|node| node.id == 2));
        assert!(!depth_path.nodes.iter().any(|node| node.id == 4));
        assert_eq!(depth_path.estimated_delay_ns, Some(0.003));

        let delay = analysis.paths_with_model(&graph, &model, 2, None, PathSort::Delay);
        let delay_path = delay
            .paths
            .iter()
            .find(|path| path.endpoint_group == "slow_output")
            .expect("the convergent output is returned");
        assert!(!delay_path.nodes.iter().any(|node| node.id == 2));
        assert!(delay_path.nodes.iter().any(|node| node.id == 4));
        assert_eq!(delay_path.estimated_delay_ns, Some(1.001));
    }

    #[test]
    fn path_variants_keep_one_route_set_across_presentation_sorts() {
        let graph = divergent_depth_delay_graph();
        let mut model = DelayModel::generic();
        model.lut_ps = 1_000.0;
        model.cell_ps = 1.0;
        model.net_base_ps = 0.0;
        model.net_per_fanout_ps = 0.0;
        let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);

        let depth = analysis.path_variants_with_model(&graph, &model, 8, None, PathSort::Depth);
        let delay = analysis.path_variants_with_model(&graph, &model, 8, None, PathSort::Delay);
        let identities = |response: &PathsResponse| {
            response
                .paths
                .iter()
                .map(|path| {
                    (
                        path.endpoint_group.clone(),
                        path.nodes.iter().map(|node| node.id).collect::<Vec<_>>(),
                    )
                })
                .collect::<HashSet<_>>()
        };

        assert_eq!(identities(&depth), identities(&delay));
        let slow_routes: Vec<_> = depth
            .paths
            .iter()
            .filter(|path| path.endpoint_group == "slow_output")
            .collect();
        assert_eq!(slow_routes.len(), 2);
        assert!(
            slow_routes
                .iter()
                .any(|path| path.nodes.iter().any(|node| node.id == 2))
        );
        assert!(
            slow_routes
                .iter()
                .any(|path| path.nodes.iter().any(|node| node.id == 4))
        );
        assert!(
            depth
                .paths
                .windows(2)
                .all(|pair| pair[0].depth >= pair[1].depth)
        );
        assert!(delay.paths.windows(2).all(|pair| {
            pair[0].estimated_delay_ns.unwrap_or(f64::NEG_INFINITY)
                >= pair[1].estimated_delay_ns.unwrap_or(f64::NEG_INFINITY)
        }));

        let bounded_depth =
            analysis.path_variants_with_model(&graph, &model, 2, None, PathSort::Depth);
        let bounded_delay =
            analysis.path_variants_with_model(&graph, &model, 2, None, PathSort::Delay);
        assert!(bounded_depth.truncated);
        assert!(bounded_delay.truncated);
        assert_eq!(identities(&bounded_depth), identities(&bounded_delay));
        assert_eq!(bounded_depth.paths.len(), 2);
        assert_eq!(bounded_delay.paths.len(), 2);
        assert_eq!(
            bounded_depth
                .paths
                .iter()
                .map(|path| path.endpoint_group.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["deep_output", "slow_output"]),
        );
        assert!(
            bounded_depth
                .paths
                .windows(2)
                .all(|pair| pair[0].depth >= pair[1].depth)
        );
        assert!(bounded_delay.paths.windows(2).all(|pair| {
            pair[0].estimated_delay_ns.unwrap_or(f64::NEG_INFINITY)
                >= pair[1].estimated_delay_ns.unwrap_or(f64::NEG_INFINITY)
        }));
    }

    #[test]
    fn path_variant_union_keeps_same_shape_routes_with_distinct_nodes() {
        let graph = same_shape_divergent_delay_graph();
        let mut model = DelayModel::generic();
        model.cell_ps = 1.0;
        model.net_base_ps = 0.0;
        model.net_per_fanout_ps = 100.0;
        let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);

        let variants = analysis.path_variants_with_model(&graph, &model, 32, None, PathSort::Depth);
        let output_routes: Vec<_> = variants
            .paths
            .iter()
            .filter(|path| path.endpoint_group == "out")
            .collect();

        assert_eq!(output_routes.len(), 2);
        assert!(
            output_routes
                .iter()
                .any(|path| path.nodes.iter().any(|node| node.id == 2))
        );
        assert!(
            output_routes
                .iter()
                .any(|path| path.nodes.iter().any(|node| node.id == 4))
        );
    }

    #[test]
    fn endpoint_truncation_follows_the_requested_sort() {
        let graph = divergent_depth_delay_graph();
        let mut model = DelayModel::generic();
        model.lut_ps = 1_000.0;
        model.cell_ps = 1.0;
        model.net_base_ps = 0.0;
        model.net_per_fanout_ps = 0.0;
        let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);

        let depth = analysis.paths_with_model(&graph, &model, 1, None, PathSort::Depth);
        assert_eq!(depth.paths[0].endpoint_group, "deep_output");
        let delay = analysis.paths_with_model(&graph, &model, 1, None, PathSort::Delay);
        assert_eq!(delay.paths[0].endpoint_group, "slow_output");
    }

    #[test]
    fn output_critical_path_does_not_charge_register_setup() {
        let graph = divergent_depth_delay_graph();
        let mut model = DelayModel::generic();
        model.lut_ps = 1_000.0;
        model.cell_ps = 1.0;
        model.ff_setup_ps = 500.0;
        model.net_base_ps = 0.0;
        model.net_per_fanout_ps = 0.0;
        let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);
        let estimate = analysis.estimate_timing(&graph, &model);
        let breakdown = estimate.breakdown.expect("an output path has timing");

        assert_eq!(estimate.delay_ns, Some(1.001));
        assert_eq!(breakdown.setup_ns, 0.0);
        assert_eq!(
            breakdown.launch_ns + breakdown.logic_ns + breakdown.net_ns,
            estimate.delay_ns.unwrap()
        );
    }

    #[test]
    fn delay_breakdown_sums_to_the_total() {
        let (_graph, analysis) = fixture("reg_mux_rtl.json");
        let total = analysis.stats.estimated_delay_ns.unwrap();
        let bd = analysis
            .stats
            .estimated_delay_breakdown
            .expect("an estimate has a breakdown");
        let sum = bd.launch_ns + bd.logic_ns + bd.net_ns + bd.setup_ns;
        assert!(
            (sum - total).abs() < 1e-9,
            "breakdown {sum} != total {total}"
        );
        // Every real path crosses at least one net; all terms are non-negative.
        // (launch is 0 when the path starts at a primary input; setup is 0 when
        // it ends at an output rather than a register.)
        assert!(bd.net_ns > 0.0);
        for term in [bd.launch_ns, bd.logic_ns, bd.net_ns, bd.setup_ns] {
            assert!(term >= 0.0);
        }
    }

    #[test]
    fn estimate_delay_ns_shrinks_with_a_faster_preset() {
        let (graph, analysis) = fixture("and_chain_rtl.json");
        let s7 = analysis
            .estimate_timing(&graph, &DelayModel::series7())
            .delay_ns
            .unwrap();
        let usp = analysis
            .estimate_timing(&graph, &DelayModel::ultrascale_plus())
            .delay_ns
            .unwrap();
        let s7_fast = analysis
            .estimate_timing(&graph, &DelayModel::series7().scaled(0.78))
            .delay_ns
            .unwrap();
        // A faster process, and a faster speed grade, both reduce the estimate.
        assert!(usp < s7, "ultrascale+ {usp} should beat series7 {s7}");
        assert!(s7_fast < s7, "-3 grade {s7_fast} should beat -1 {s7}");
    }

    #[test]
    fn register_grouping_uses_q_net() {
        let (_graph, analysis) = fixture("reg_mux_rtl.json");
        let q = analysis
            .endpoints
            .registers
            .iter()
            .find(|group| group.name == "q")
            .unwrap();
        assert_eq!(q.width, 8);
        assert_eq!(q.worst_depth, 1);
        let alias = q
            .output_aliases
            .iter()
            .find(|alias| alias.name == "q")
            .expect("direct top-level registered output should be grouped with q");
        assert_eq!(alias.bits.len(), 8);
        assert!(
            analysis
                .endpoints
                .outputs
                .iter()
                .all(|output| output.name != "q")
        );
        assert_eq!(analysis.stats.depths.input_to_register, Some(1));
    }

    #[test]
    fn hidden_vector_group_identities_preserve_yosys_separators() {
        assert_eq!(hidden_vector_group_name("$a$b[0]").as_deref(), Some("$a$b"));
        assert_eq!(hidden_vector_group_name("$a.b[1]").as_deref(), Some("$a.b"));
        assert_ne!(
            hidden_vector_group_name("$a$b[0]"),
            hidden_vector_group_name("$a.b[1]")
        );
        assert_eq!(hidden_vector_group_name("$scalar"), None);
    }

    #[test]
    fn grouped_controls_compact_distinct_nets_without_losing_drivers() {
        let control =
            |role, pin: &str, net: &str, driver_id, fanout, src: Option<&str>| ControlRef {
                role,
                pin: pin.to_owned(),
                net_name: net.to_owned(),
                driver_id,
                driver_ids: Vec::new(),
                net_count: None,
                fanout,
                active_low: Some(false),
                synchronous: None,
                src: src.map(str::to_owned),
                generated: None,
            };
        let mut controls = vec![control(
            ControlRole::Clock,
            "CLK",
            "clk",
            1,
            2_048,
            Some("top.sv:2"),
        )];
        for row in 0..128 {
            controls.push(control(
                ControlRole::Enable,
                "EN",
                &format!("row_en[{row}]"),
                row + 2,
                16,
                (row == 0).then_some("top.sv:8"),
            ));
        }
        let compact = compact_group_controls(controls);

        assert_eq!(compact.len(), 2);
        assert_eq!(compact[0].role, ControlRole::Clock);
        assert_eq!(compact[0].net_count, None);
        assert!(compact[0].driver_ids.is_empty());
        assert_eq!(compact[1].role, ControlRole::Enable);
        assert_eq!(compact[1].net_count, Some(128));
        assert_eq!(compact[1].driver_ids, (2..130).collect::<Vec<_>>());
        assert_eq!(compact[1].fanout, 2_048);
        assert_eq!(compact[1].src, None);
    }

    #[test]
    fn detects_combinational_loop_fixture() {
        let (graph, analysis) = fixture("comb_loop_rtl.json");
        assert_eq!(analysis.comb_loops.len(), 2);
        let names: Vec<_> = analysis
            .comb_loops
            .iter()
            .map(|id| graph.node_ref_name(*id))
            .collect();
        assert!(names.iter().any(|name| name.contains("$not")));
    }

    #[test]
    fn analysis_handles_deep_comb_chain_without_recursive_scc_stack() {
        let depth = 200_000usize;
        let graph = deep_chain_graph(depth);
        let started = Instant::now();
        let analysis = Analysis::new(&graph, vec!["deep_chain.sv".to_owned()]);
        assert!(started.elapsed().as_secs() < 10);
        assert!(analysis.comb_loops.is_empty());
        assert_eq!(analysis.stats.max_depth, depth as u32);

        let paths = analysis.paths(&graph, 1, None);
        assert!(paths.truncated);
        assert_eq!(paths.paths.len(), 1);
        let path = &paths.paths[0];
        assert_eq!(path.nodes.len(), PATH_NODE_CAP);
        assert_eq!(path.startpoint.id, 0);
        assert_eq!(path.endpoint.id, (depth + 1) as NodeId);
        assert_eq!(
            path.nodes.first().map(|node| node.id),
            Some(path.startpoint.id)
        );
        assert_eq!(
            path.nodes.last().map(|node| node.id),
            Some(path.endpoint.id)
        );
    }

    #[test]
    fn path_sampling_represents_deepest_logical_groups_before_extra_bits() {
        let graph = register_bank_graph(30, 64);
        let analysis = Analysis::new(&graph, vec!["register_bank.sv".to_owned()]);

        let paths = analysis.paths(&graph, 25, None);
        let groups: HashSet<_> = paths
            .paths
            .iter()
            .map(|path| path.endpoint_group.as_str())
            .collect();
        assert_eq!(paths.paths.len(), 25);
        assert_eq!(groups.len(), 25);
        assert!(paths.truncated);

        let all_paths = analysis.paths(&graph, MAX_PATH_RESULTS, None);
        let all_groups: HashSet<_> = all_paths
            .paths
            .iter()
            .map(|path| path.endpoint_group.as_str())
            .collect();
        assert_eq!(all_paths.paths.len(), 30);
        assert_eq!(all_groups.len(), 30);
        assert!(!all_paths.truncated);
    }

    #[test]
    fn wide_register_endpoint_discovery_is_near_linear() {
        let width = 20_000;
        let graph = register_bank_graph(1, width);
        let started = Instant::now();
        let analysis = Analysis::new(&graph, vec!["wide_register.sv".to_owned()]);

        assert!(started.elapsed().as_secs() < 5);
        assert_eq!(analysis.endpoints.registers.len(), 1);
        assert_eq!(analysis.endpoints.registers[0].bits.len(), width);
        assert_eq!(
            analysis.endpoints.registers[0].bits[width - 1].bit,
            width - 1
        );
    }

    #[test]
    fn wide_bus_edges_merge_once_and_remain_deterministic() {
        let width = 20_000u32;
        let edges: Vec<Edge> = (0..width)
            .rev()
            .map(|bit| Edge {
                from: 0,
                to: 1,
                from_port: "Y".to_owned(),
                to_port: "D".to_owned(),
                to_port_bit: bit,
                bit: Some(bit),
                net_name: "wide_bus".to_owned(),
                control: false,
            })
            .collect();
        let started = Instant::now();
        let (merged, truncated) = merge_edges(edges.iter().collect());

        assert!(started.elapsed().as_secs() < 5);
        assert!(truncated);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].bits.len(), MAX_SUBGRAPH_EDGE_BITS);
        assert_eq!(merged[0].bits.first(), Some(&10_000));
        assert_eq!(merged[0].bits.last(), Some(&(width - 1)));
    }

    #[test]
    fn wide_parallel_edges_do_not_starve_other_root_connections() {
        let wide_edge_count = MAX_FULL_NETLIST_EDGE_VISITS * 2;
        let mut edges: Vec<Edge> = (0..wide_edge_count)
            .map(|bit| Edge {
                from: 0,
                to: 1,
                from_port: "Y".to_owned(),
                to_port: "D".to_owned(),
                to_port_bit: bit as u32,
                bit: Some(bit as u32),
                net_name: "wide".to_owned(),
                control: false,
            })
            .collect();
        edges.push(Edge {
            from: 2,
            to: 3,
            from_port: "Y".to_owned(),
            to_port: "A".to_owned(),
            to_port_bit: 0,
            bit: Some(0),
            net_name: "other".to_owned(),
            control: false,
        });
        let mut outgoing = vec![Vec::new(); 4];
        outgoing[0] = (0..wide_edge_count).collect();
        outgoing[2].push(wide_edge_count);
        let mut incoming = vec![Vec::new(); 4];
        incoming[1] = (0..wide_edge_count).collect();
        incoming[3].push(wide_edge_count);
        let graph = graph_from_parts(
            "wide_and_other",
            (0..4)
                .map(|id| combinational_node(id, "$and", None))
                .collect(),
            edges,
            outgoing,
            incoming,
        );
        let analysis = Analysis::new(&graph, Vec::new());

        let full = analysis.full_netlist(&graph, full_options(4, true, false, false, &[]), None);
        assert!(full.truncated);
        assert!(full.edges.iter().any(|edge| edge.from == 2 && edge.to == 3));
        assert!(
            full.edges
                .iter()
                .find(|edge| edge.from == 0 && edge.to == 1)
                .is_some_and(|edge| edge.bits.len() <= MAX_FULL_GROUP_MEMBERS)
        );

        let context =
            analysis.full_netlist(&graph, full_options(4, true, false, false, &[0, 2]), None);
        assert!(
            context
                .edges
                .iter()
                .any(|edge| edge.from == 2 && edge.to == 3)
        );

        let cone = analysis
            .multi_root_cone(
                &graph,
                &[0, 2],
                ConeOptions {
                    dir: ConeDir::Fanout,
                    max_depth: 64,
                    max_nodes: 4,
                    hide_control: false,
                    hide_const: false,
                    show_infrastructure: true,
                    root_port: None,
                    root_port_bit: None,
                    root_port_bits: None,
                },
                None,
            )
            .unwrap();
        assert!(cone.edges.iter().any(|edge| edge.from == 2 && edge.to == 3));
    }

    #[test]
    fn dense_subgraphs_enforce_the_merged_edge_cap_deterministically() {
        let graph = dense_dag_graph(150);
        let analysis = Analysis::new(&graph, vec!["dense.sv".to_owned()]);

        let first = analysis.full_netlist(
            &graph,
            full_options(MAX_SUBGRAPH_NODES, true, true, false, &[]),
            None,
        );
        let second = analysis.full_netlist(
            &graph,
            full_options(MAX_SUBGRAPH_NODES, true, true, false, &[]),
            None,
        );

        assert_eq!(first.edges.len(), MAX_SUBGRAPH_EDGES);
        assert!(first.truncated);
        assert_eq!(edge_signature(&first), edge_signature(&second));
    }

    #[test]
    fn full_netlist_filters_controls_before_the_edge_cap() {
        let mut graph = dense_dag_graph(150);
        for edge in graph.edges.iter_mut().take(MAX_SUBGRAPH_EDGES + 1) {
            edge.control = true;
            edge.to_port = "C".to_owned();
        }
        let visible_data_edges = graph.edges.len() - (MAX_SUBGRAPH_EDGES + 1);
        let analysis = Analysis::new(&graph, vec!["dense_controls.sv".to_owned()]);

        let controls_visible = analysis.full_netlist(
            &graph,
            full_options(MAX_SUBGRAPH_NODES, true, false, false, &[]),
            None,
        );
        assert_eq!(controls_visible.edges.len(), MAX_SUBGRAPH_EDGES);
        assert!(controls_visible.truncated);

        let controls_hidden = analysis.full_netlist(
            &graph,
            full_options(MAX_SUBGRAPH_NODES, true, true, false, &[]),
            None,
        );
        assert_eq!(controls_hidden.edges.len(), visible_data_edges);
        assert!(!controls_hidden.truncated);
        assert!(
            controls_hidden
                .edges
                .iter()
                .all(|edge| edge.control.is_none())
        );
    }

    #[test]
    fn full_netlist_prioritizes_context_nearest_to_relevant_roots() {
        let graph = deep_chain_graph(10);
        let analysis = Analysis::new(&graph, vec!["nearby.sv".to_owned()]);

        let nearby = analysis.full_netlist(&graph, full_options(3, true, true, false, &[8]), None);

        assert_eq!(
            nearby
                .nodes
                .iter()
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![7, 8, 9]
        );
        assert_eq!(
            nearby
                .edges
                .iter()
                .map(|edge| (edge.from, edge.to))
                .collect::<Vec<_>>(),
            vec![(7, 8), (8, 9)]
        );
        assert!(nearby.truncated);
    }

    #[test]
    fn infrastructure_projection_caps_intermediate_work_and_output() {
        let (graph, subgraph) = branching_infrastructure_subgraph(100, 101);

        let first = cap_subgraph_edges(collapse_infrastructure(&graph, subgraph.clone()));
        let second = cap_subgraph_edges(collapse_infrastructure(&graph, subgraph));

        assert!(first.truncated);
        assert!(first.edges.len() <= MAX_SUBGRAPH_EDGES);
        assert_eq!(edge_signature(&first), edge_signature(&second));
    }

    #[test]
    fn transparent_buffer_collapses_even_as_a_cone_root() {
        // n0 ($and) -> n1 (OBUF, cone root) -> n2 ($and). A source line can map
        // straight onto the OBUF, making it a root; hiding infrastructure must
        // still collapse the buffer and bridge n0 -> n2 rather than leaving the
        // OBUF on screen ("IBUF shows with infrastructure off").
        let graph = graph_from_parts(
            "buf",
            vec![
                combinational_node(0, "$and", None),
                combinational_node(1, "OBUF", None),
                combinational_node(2, "$and", None),
            ],
            Vec::new(),
            vec![Vec::new(); 3],
            vec![Vec::new(); 3],
        );
        let mk = |id: NodeId, root: bool| GraphNode {
            node: node_ref(&graph, id),
            is_root: root.then_some(true),
            is_boundary: None,
            depth: None,
            params: BTreeMap::new(),
            controls: Vec::new(),
            width: None,
            member_count: None,
            members: None,
        };
        let subgraph = Subgraph {
            nodes: vec![mk(0, false), mk(1, true), mk(2, false)],
            edges: vec![
                GraphEdge {
                    from: 0,
                    to: 1,
                    from_port: "Y".to_owned(),
                    to_port: "I".to_owned(),
                    net_name: "a".to_owned(),
                    bits: vec![0],
                    control: None,
                },
                GraphEdge {
                    from: 1,
                    to: 2,
                    from_port: "O".to_owned(),
                    to_port: "A".to_owned(),
                    net_name: "y".to_owned(),
                    bits: vec![0],
                    control: None,
                },
            ],
            truncated: false,
        };

        let out = collapse_infrastructure(&graph, subgraph);

        assert!(
            out.nodes.iter().all(|n| n.node.id != 1),
            "the root OBUF must collapse when infrastructure is hidden"
        );
        assert!(
            out.edges.iter().any(|e| e.from == 0 && e.to == 2),
            "n0 must bridge directly to n2 through the hidden buffer"
        );
    }

    #[test]
    fn infrastructure_projection_borrows_wide_bits_across_branching_queue() {
        let branches = 4_500;
        let (graph, subgraph) = wide_branching_infrastructure_subgraph(20_000, branches);
        let started = Instant::now();

        let projected = collapse_infrastructure(&graph, subgraph);

        assert!(started.elapsed().as_secs() < 5);
        assert!(!projected.truncated);
        assert_eq!(projected.edges.len(), branches);
        assert!(projected.edges.iter().all(|edge| edge.bits.len() == 1));
    }

    #[test]
    fn infrastructure_projection_preserves_reconvergent_bit_sources() {
        let nodes = (0..=5)
            .map(|id| {
                combinational_node(id, if matches!(id, 0 | 5) { "$and" } else { "OBUF" }, None)
            })
            .collect();
        let graph = graph_from_parts(
            "reconvergent_projection",
            nodes,
            Vec::new(),
            vec![Vec::new(); 6],
            vec![Vec::new(); 6],
        );
        let projected_nodes = graph
            .nodes
            .iter()
            .map(|node| GraphNode {
                node: node_ref(&graph, node.id),
                is_root: None,
                is_boundary: None,
                depth: None,
                params: BTreeMap::new(),
                controls: Vec::new(),
                width: None,
                member_count: None,
                members: None,
            })
            .collect();
        let edge = |from, to, bits: Vec<u32>| GraphEdge {
            from,
            to,
            from_port: "O".to_owned(),
            to_port: "I".to_owned(),
            net_name: format!("n{from}_{to}"),
            bits,
            control: None,
        };
        let subgraph = Subgraph {
            nodes: projected_nodes,
            edges: vec![
                edge(0, 1, vec![99]),
                edge(1, 2, vec![1]),
                edge(1, 3, vec![2]),
                edge(2, 4, Vec::new()),
                edge(3, 4, Vec::new()),
                edge(4, 5, Vec::new()),
            ],
            truncated: false,
        };

        let projected = collapse_infrastructure(&graph, subgraph);

        assert_eq!(projected.edges.len(), 1);
        assert_eq!(projected.edges[0].bits, vec![1, 2]);
    }

    #[test]
    fn path_reconstruction_obeys_the_shared_node_budget() {
        let graph = deep_register_bank_graph(400, 256);
        let analysis = Analysis::new(&graph, vec!["deep_bank.sv".to_owned()]);

        let paths = analysis.paths(&graph, 500, None);
        let reconstructed_nodes: usize = paths.paths.iter().map(|path| path.nodes.len()).sum();
        let groups: HashSet<_> = paths
            .paths
            .iter()
            .map(|path| path.endpoint_group.as_str())
            .collect();

        assert!(paths.truncated);
        assert!(paths.paths.len() < 400);
        assert_eq!(groups.len(), paths.paths.len());
        assert!(reconstructed_nodes <= PATH_RECONSTRUCTION_NODE_BUDGET);

        let (variants, variant_reconstruction_work) = analysis.path_variants_with_model_and_work(
            &graph,
            &DelayModel::generic(),
            500,
            None,
            PathSort::Depth,
        );
        let variant_nodes: usize = variants.paths.iter().map(|path| path.nodes.len()).sum();
        assert!(variants.truncated);
        assert!(variant_nodes <= PATH_RECONSTRUCTION_NODE_BUDGET);
        assert!(variant_reconstruction_work > PATH_RECONSTRUCTION_NODE_BUDGET / 2);
        assert!(variant_reconstruction_work <= PATH_RECONSTRUCTION_NODE_BUDGET);
    }

    #[test]
    fn source_selection_returns_only_the_bounded_projection() {
        let graph = graph_from_parts(
            "source_selection",
            vec![combinational_node(0, "$and", Some("source.sv:10"))],
            Vec::new(),
            vec![Vec::new()],
            vec![Vec::new()],
        );
        let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
        let module = YosysModule {
            attributes: BTreeMap::new(),
            ports: BTreeMap::new(),
            cells: BTreeMap::new(),
            memories: BTreeMap::new(),
            netnames: BTreeMap::new(),
        };
        let source_index = SourceLineIndex::from_module(&module, vec!["source.sv".to_owned()]);

        let result = analysis
            .source_selection(
                &graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "source.sv",
                    start_line: 10,
                    end_line: 10,
                    start_column: None,
                    end_column: None,
                },
                SourceSelectionOptions {
                    max_nodes: 400,
                    hide_control: true,
                    hide_const: true,
                    group_vectors: false,
                    group_memories: false,
                },
            )
            .unwrap();

        assert_eq!(result.status, SourceSelectionStatus::Mapped);
        assert_eq!(result.direct_ids, vec![0]);
        assert_eq!(result.graph.nodes.len(), 1);
        assert_eq!(result.graph.nodes[0].is_root, Some(true));
    }

    #[test]
    fn source_selection_keeps_a_large_design_response_bounded() {
        let node_count = 50_000;
        let nodes = (0..node_count)
            .map(|id| {
                combinational_node(
                    id as NodeId,
                    "$and",
                    (id == node_count / 2).then_some("source.sv:10"),
                )
            })
            .collect();
        let graph = graph_from_parts(
            "large_source_selection",
            nodes,
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        );
        let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
        let source_index = empty_source_index("source.sv");
        let started = Instant::now();

        let result = analysis
            .source_selection(
                &graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "source.sv",
                    start_line: 10,
                    end_line: 10,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();

        assert!(started.elapsed().as_secs() < 1);
        assert_eq!(result.status, SourceSelectionStatus::Mapped);
        assert_eq!(result.graph.nodes.len(), 1);
        assert_eq!(result.graph.nodes[0].node.id, (node_count / 2) as NodeId);
    }

    #[test]
    fn grouped_source_selection_caps_raw_members_and_serialized_payload() {
        let group_member_count = 5_000;
        let context_id = group_member_count as NodeId;
        let mut incoming = vec![Vec::new(); group_member_count + 1];
        let mut outgoing = vec![Vec::new(); group_member_count + 1];
        incoming[0].push(0);
        outgoing[context_id as usize].push(0);
        let graph = graph_from_parts(
            "wide_group",
            (0..group_member_count)
                .map(|id| combinational_node(id as NodeId, "$and", Some("source.sv:10")))
                .chain(std::iter::once(combinational_node(
                    context_id, "$not", None,
                )))
                .collect(),
            vec![Edge {
                from: context_id,
                to: 0,
                from_port: "Y".to_owned(),
                to_port: "A".to_owned(),
                to_port_bit: 0,
                bit: Some(0),
                net_name: "context".to_owned(),
                control: false,
            }],
            outgoing,
            incoming,
        );
        let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
        let grouping = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Comb,
                members: (0..group_member_count as NodeId).collect(),
                label: "wide_logic".to_owned(),
                cell_type: "$and".to_owned(),
            }],
            group_of: (0..group_member_count as NodeId)
                .map(|id| (id, 0))
                .collect(),
        };

        let full = analysis.full_netlist(
            &graph,
            full_options(1, false, true, false, &[]),
            Some(GroupingProjection::all(&grouping)),
        );
        assert!(full.truncated);
        assert_eq!(full.nodes.len(), 1);
        assert_eq!(full.nodes[0].width, Some(MAX_FULL_GROUP_MEMBERS as u32));
        assert_eq!(full.nodes[0].member_count, Some(group_member_count as u32));
        assert_eq!(
            full.nodes[0].members.as_ref().unwrap().len(),
            MAX_FULL_GROUP_MEMBERS
        );
        assert!(serde_json::to_vec(&full).unwrap().len() < 100_000);

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("source.sv"),
                &grouping,
                SourceSelectionRange {
                    file: "source.sv",
                    start_line: 10,
                    end_line: 10,
                    start_column: None,
                    end_column: None,
                },
                SourceSelectionOptions {
                    group_vectors: true,
                    ..selection_options()
                },
            )
            .unwrap();

        assert!(result.graph.truncated);
        assert_eq!(result.graph.nodes.len(), 2);
        let grouped = result
            .graph
            .nodes
            .iter()
            .find(|node| node.member_count.is_some())
            .expect("the grouped source roots remain projected");
        assert_eq!(grouped.width, Some(MAX_FULL_GROUP_MEMBERS as u32));
        assert_eq!(grouped.member_count, Some(group_member_count as u32));
        assert_eq!(
            grouped.members.as_ref().unwrap().len(),
            MAX_FULL_GROUP_MEMBERS
        );
        assert!(
            result
                .graph
                .nodes
                .iter()
                .any(|node| node.node.id == context_id)
        );
        assert_eq!(result.graph.edges.len(), 1);
        assert!(serde_json::to_vec(&result).unwrap().len() < 100_000);
    }

    #[test]
    fn full_netlist_samples_wide_groups_without_starving_other_units() {
        let group_member_count = 4_096;
        let singleton_count = 10;
        let node_count = group_member_count + singleton_count;
        let graph = graph_from_parts(
            "wide_group_with_context",
            (0..node_count)
                .map(|id| combinational_node(id as NodeId, "$and", None))
                .collect(),
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        );
        let analysis = Analysis::new(&graph, Vec::new());
        let grouping = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Comb,
                members: (0..group_member_count as NodeId).collect(),
                label: "wide_logic".to_owned(),
                cell_type: "$and".to_owned(),
            }],
            group_of: (0..group_member_count as NodeId)
                .map(|id| (id, 0))
                .collect(),
        };

        let result = analysis.full_netlist(
            &graph,
            full_options(singleton_count + 1, false, true, false, &[]),
            Some(GroupingProjection::all(&grouping)),
        );

        assert!(result.truncated);
        assert_eq!(result.nodes.len(), singleton_count + 1);
        assert_eq!(
            result
                .nodes
                .iter()
                .find(|node| node.member_count.is_some())
                .and_then(|node| node.width),
            Some(MAX_FULL_GROUP_MEMBERS as u32)
        );
        for id in group_member_count as NodeId..node_count as NodeId {
            assert!(result.nodes.iter().any(|node| node.node.id == id));
        }
    }

    #[test]
    fn context_netlist_samples_a_wide_group_and_keeps_its_neighbor() {
        let group_member_count = 4_096;
        let context_id = group_member_count as NodeId;
        let mut outgoing = vec![Vec::new(); group_member_count + 1];
        let mut incoming = vec![Vec::new(); group_member_count + 1];
        outgoing[0].push(0);
        incoming[context_id as usize].push(0);
        let graph = graph_from_parts(
            "wide_context_group",
            (0..group_member_count)
                .map(|id| combinational_node(id as NodeId, "$and", None))
                .chain(std::iter::once(combinational_node(
                    context_id, "$not", None,
                )))
                .collect(),
            vec![Edge {
                from: 0,
                to: context_id,
                from_port: "Y".to_owned(),
                to_port: "A".to_owned(),
                to_port_bit: 0,
                bit: Some(0),
                net_name: "context".to_owned(),
                control: false,
            }],
            outgoing,
            incoming,
        );
        let analysis = Analysis::new(&graph, Vec::new());
        let grouping = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Comb,
                members: (0..group_member_count as NodeId).collect(),
                label: "wide_logic".to_owned(),
                cell_type: "$and".to_owned(),
            }],
            group_of: (0..group_member_count as NodeId)
                .map(|id| (id, 0))
                .collect(),
        };
        let roots: Vec<NodeId> = (0..group_member_count as NodeId).collect();

        let result = analysis.full_netlist(
            &graph,
            full_options(10, false, true, false, &roots),
            Some(GroupingProjection::all(&grouping)),
        );

        assert!(result.truncated);
        assert_eq!(result.nodes.len(), 2);
        assert!(result.nodes.iter().any(|node| node.node.id == context_id));
        let grouped = result
            .nodes
            .iter()
            .find(|node| node.member_count.is_some())
            .expect("wide group remains projected");
        assert_eq!(grouped.width, Some(MAX_FULL_GROUP_MEMBERS as u32));
        assert_eq!(grouped.member_count, Some(group_member_count as u32));
        assert_eq!(result.edges.len(), 1);
    }

    #[test]
    fn grouped_root_frontiers_share_context_capacity_fairly() {
        let node_count = 8;
        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); node_count];
        let mut incoming = vec![Vec::new(); node_count];
        for neighbor in 2..7 {
            add_test_edge(
                &mut edges,
                &mut outgoing,
                &mut incoming,
                0,
                neighbor,
                neighbor,
            );
        }
        add_test_edge(&mut edges, &mut outgoing, &mut incoming, 1, 7, 7);
        let graph = graph_from_parts(
            "fair_root_frontiers",
            (0..node_count)
                .map(|id| combinational_node(id as NodeId, "$and", None))
                .collect(),
            edges,
            outgoing,
            incoming,
        );
        let analysis = Analysis::new(&graph, Vec::new());
        let grouping = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Comb,
                members: vec![0, 1],
                label: "roots[1:0]".to_owned(),
                cell_type: "$and".to_owned(),
            }],
            group_of: HashMap::from([(0, 0), (1, 0)]),
        };
        let projection = Some(GroupingProjection::all(&grouping));
        let cone = analysis
            .multi_root_cone(
                &graph,
                &[0, 1],
                ConeOptions {
                    dir: ConeDir::Fanout,
                    max_depth: 64,
                    max_nodes: 3,
                    hide_control: true,
                    hide_const: true,
                    show_infrastructure: true,
                    root_port: None,
                    root_port_bit: None,
                    root_port_bits: None,
                },
                projection,
            )
            .unwrap();
        assert!(cone.nodes.iter().any(|node| node.node.id == 7));

        let context = analysis.full_netlist(
            &graph,
            full_options(3, true, true, false, &[0, 1]),
            projection,
        );
        assert!(context.nodes.iter().any(|node| node.node.id == 7));
    }

    #[test]
    fn hidden_edges_on_one_root_do_not_starve_another_root() {
        let hidden_count = MAX_SUBGRAPH_EDGES * 2;
        let mut edges: Vec<Edge> = (0..hidden_count)
            .map(|bit| Edge {
                from: 0,
                to: 2,
                from_port: "Y".to_owned(),
                to_port: "C".to_owned(),
                to_port_bit: bit as u32,
                bit: Some(bit as u32),
                net_name: "hidden_clock".to_owned(),
                control: true,
            })
            .collect();
        edges.push(Edge {
            from: 1,
            to: 3,
            from_port: "Y".to_owned(),
            to_port: "A".to_owned(),
            to_port_bit: 0,
            bit: Some(0),
            net_name: "visible".to_owned(),
            control: false,
        });
        let mut outgoing = vec![Vec::new(); 4];
        outgoing[0] = (0..hidden_count).collect();
        outgoing[1].push(hidden_count);
        let mut incoming = vec![Vec::new(); 4];
        incoming[2] = (0..hidden_count).collect();
        incoming[3].push(hidden_count);
        let graph = graph_from_parts(
            "hidden_root_fairness",
            (0..4)
                .map(|id| combinational_node(id, "$and", None))
                .collect(),
            edges,
            outgoing,
            incoming,
        );
        let analysis = Analysis::new(&graph, Vec::new());

        let result = analysis
            .multi_root_cone(
                &graph,
                &[0, 1],
                ConeOptions {
                    dir: ConeDir::Fanout,
                    max_depth: 64,
                    max_nodes: 4,
                    hide_control: true,
                    hide_const: true,
                    show_infrastructure: true,
                    root_port: None,
                    root_port_bit: None,
                    root_port_bits: None,
                },
                None,
            )
            .unwrap();

        assert!(result.truncated);
        assert!(result.nodes.iter().any(|node| node.node.id == 3));
        assert!(
            result
                .edges
                .iter()
                .any(|edge| edge.from == 1 && edge.to == 3)
        );
    }

    #[test]
    fn ungrouped_root_budget_stratifies_across_the_full_request() {
        let roots: Vec<NodeId> = (0..256).collect();

        let (bounded, truncated) = bounded_projection_roots(&roots, None, 256, 50, 1_000);

        assert!(truncated);
        assert_eq!(bounded.len(), 25);
        assert_eq!(bounded.first(), Some(&0));
        assert_eq!(bounded.last(), Some(&255));
    }

    #[test]
    fn shared_group_budgets_stratify_every_admitted_group_end_to_end() {
        let group_count = 25usize;
        let members_per_group = 2_048usize;
        let node_count = group_count * members_per_group;
        let grouping = GroupPartition {
            groups: (0..group_count)
                .map(|group| Group {
                    kind: GroupKind::Memory,
                    members: ((group * members_per_group) as NodeId
                        ..((group + 1) * members_per_group) as NodeId)
                        .collect(),
                    label: format!("memory{group} [2048x1]"),
                    cell_type: "$mem".to_owned(),
                })
                .collect(),
            group_of: (0..node_count as NodeId)
                .map(|id| (id, id / members_per_group as NodeId))
                .collect(),
        };
        let projection = GroupingProjection::all(&grouping);
        let roots: Vec<NodeId> = (0..node_count as NodeId).collect();

        let (bounded, truncated) = bounded_projection_roots(
            &roots,
            Some(projection),
            node_count as NodeId,
            group_count * 2,
            1_000,
        );

        assert!(truncated);
        assert_eq!(bounded.len(), 1_000);
        for group in 0..group_count {
            let first = (group * members_per_group) as NodeId;
            let last = ((group + 1) * members_per_group - 1) as NodeId;
            let sampled: Vec<NodeId> = bounded
                .iter()
                .copied()
                .filter(|member| (*member >= first) && (*member <= last))
                .collect();
            assert_eq!(sampled.len(), 40, "group {group}");
            assert_eq!(sampled.first(), Some(&first), "group {group}");
            assert_eq!(sampled.last(), Some(&last), "group {group}");
        }

        let graph = graph_from_parts(
            "many_wide_memories",
            (0..node_count)
                .map(|id| combinational_node(id as NodeId, "$and", None))
                .collect(),
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        );
        let analysis = Analysis::new(&graph, Vec::new());
        let full = analysis.full_netlist(
            &graph,
            full_options(group_count, false, true, false, &[]),
            Some(projection),
        );

        assert!(full.truncated);
        assert_eq!(full.nodes.len(), group_count);
        for node in &full.nodes {
            assert_eq!(node.width, Some(80));
            assert_eq!(node.member_count, Some(members_per_group as u32));
            let members = node.members.as_ref().expect("sampled group members");
            let group = (node.node.id - node_count as NodeId) as usize;
            assert_eq!(
                members.first(),
                Some(&((group * members_per_group) as NodeId))
            );
            assert_eq!(
                members.last(),
                Some(&(((group + 1) * members_per_group - 1) as NodeId))
            );
        }
    }

    #[test]
    fn memory_and_vector_grouping_policies_are_independent() {
        let graph = graph_from_parts(
            "selective_grouping",
            (0..4)
                .map(|id| combinational_node(id, "$and", None))
                .collect(),
            Vec::new(),
            vec![Vec::new(); 4],
            vec![Vec::new(); 4],
        );
        let analysis = Analysis::new(&graph, Vec::new());
        let grouping = GroupPartition {
            groups: vec![
                Group {
                    kind: GroupKind::Memory,
                    members: vec![0, 1],
                    label: "memory [2×1]".to_owned(),
                    cell_type: "$mem".to_owned(),
                },
                Group {
                    kind: GroupKind::Register,
                    members: vec![2, 3],
                    label: "register[1:0]".to_owned(),
                    cell_type: "$dff".to_owned(),
                },
            ],
            group_of: HashMap::from([(0, 0), (1, 0), (2, 1), (3, 1)]),
        };

        let memory_only = analysis.full_netlist(
            &graph,
            full_options(4, false, true, false, &[]),
            Some(GroupingProjection {
                partition: &grouping,
                vectors: false,
                memories: true,
            }),
        );
        assert_eq!(memory_only.nodes.len(), 3);
        assert!(memory_only.nodes.iter().any(|node| node.node.id == 4));
        assert!(memory_only.nodes.iter().any(|node| node.node.id == 2));
        assert!(memory_only.nodes.iter().any(|node| node.node.id == 3));

        let vectors_only = analysis.full_netlist(
            &graph,
            full_options(4, false, true, false, &[]),
            Some(GroupingProjection {
                partition: &grouping,
                vectors: true,
                memories: false,
            }),
        );
        assert_eq!(vectors_only.nodes.len(), 3);
        assert!(vectors_only.nodes.iter().any(|node| node.node.id == 5));
        assert!(vectors_only.nodes.iter().any(|node| node.node.id == 0));
        assert!(vectors_only.nodes.iter().any(|node| node.node.id == 1));
    }

    #[test]
    fn full_netlist_reserves_a_bounded_memory_sample_before_graph_order() {
        let node_count = 5_000;
        let memory_start = 4_000;
        let graph = graph_from_parts(
            "late_memory",
            (0..node_count)
                .map(|id| combinational_node(id as NodeId, "$and", None))
                .collect(),
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        );
        let analysis = Analysis::new(&graph, Vec::new());
        let grouping = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Memory,
                members: (memory_start as NodeId..node_count as NodeId).collect(),
                label: "memory [1000×1]".to_owned(),
                cell_type: "$mem".to_owned(),
            }],
            group_of: (memory_start as NodeId..node_count as NodeId)
                .map(|id| (id, 0))
                .collect(),
        };

        let result = analysis.full_netlist(
            &graph,
            full_options(400, false, true, false, &[]),
            Some(GroupingProjection::all(&grouping)),
        );
        let memory = result
            .nodes
            .iter()
            .find(|node| node.node.id == node_count as NodeId)
            .expect("the late-sorting logical memory remains visible");

        assert!(result.truncated);
        assert_eq!(result.nodes.len(), 400);
        assert_eq!(memory.width, Some(MAX_FULL_GROUP_MEMBERS as u32));
        assert_eq!(memory.member_count, Some(1_000));
        assert_eq!(
            memory.members.as_ref().unwrap().len(),
            MAX_FULL_GROUP_MEMBERS
        );
    }

    #[test]
    fn full_netlist_reserves_every_memory_before_distributing_samples() {
        let group_count = 10;
        let members_per_group = 300;
        let node_count = group_count * members_per_group;
        let graph = graph_from_parts(
            "many_memories",
            (0..node_count)
                .map(|id| combinational_node(id as NodeId, "$and", None))
                .collect(),
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        );
        let analysis = Analysis::new(&graph, Vec::new());
        let grouping = GroupPartition {
            groups: (0..group_count)
                .map(|group| Group {
                    kind: GroupKind::Memory,
                    members: ((group * members_per_group) as NodeId
                        ..((group + 1) * members_per_group) as NodeId)
                        .collect(),
                    label: format!("memory{group} [300×1]"),
                    cell_type: "$mem".to_owned(),
                })
                .collect(),
            group_of: (0..node_count as NodeId)
                .map(|id| (id, id / members_per_group as NodeId))
                .collect(),
        };

        let result = analysis.full_netlist(
            &graph,
            full_options(group_count, false, true, false, &[]),
            Some(GroupingProjection::all(&grouping)),
        );

        assert!(result.truncated);
        assert_eq!(result.nodes.len(), group_count);
        assert!(result.nodes.iter().all(|node| {
            node.members
                .as_ref()
                .is_some_and(|members| !members.is_empty())
        }));
        assert!(
            result
                .nodes
                .iter()
                .map(|node| node.members.as_ref().map_or(0, Vec::len))
                .sum::<usize>()
                <= MAX_SUBGRAPH_NODES
        );
    }

    #[test]
    fn source_selection_caps_raw_edge_bits_before_serialization() {
        let edge_count = MAX_SUBGRAPH_EDGES * 2;
        let edges: Vec<Edge> = (0..edge_count)
            .map(|bit| Edge {
                from: 0,
                to: 1,
                from_port: "a".to_owned(),
                to_port: "A".to_owned(),
                to_port_bit: bit as u32,
                bit: Some(bit as u32),
                net_name: "wide".to_owned(),
                control: false,
            })
            .collect();
        let graph = graph_from_parts(
            "wide_edges",
            vec![
                port_node(0, "a", PortDirection::Input),
                combinational_node(1, "$and", Some("source.sv:10")),
            ],
            edges,
            vec![(0..edge_count).collect(), Vec::new()],
            vec![Vec::new(), (0..edge_count).collect()],
        );
        let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("source.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "source.sv",
                    start_line: 10,
                    end_line: 10,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();

        assert!(result.graph.truncated);
        assert_eq!(result.graph.edges.len(), 1);
        assert_eq!(result.graph.edges[0].bits.len(), MAX_FULL_GROUP_MEMBERS);

        let full = analysis.full_netlist(&graph, full_options(2, true, false, false, &[]), None);
        assert!(full.truncated);
        assert_eq!(full.edges.len(), 1);
        assert_eq!(full.edges[0].bits.len(), MAX_FULL_GROUP_MEMBERS);

        let context =
            analysis.full_netlist(&graph, full_options(2, true, false, false, &[1]), None);
        assert!(context.truncated);
        assert_eq!(context.edges.len(), 1);
        assert_eq!(context.edges[0].bits.len(), MAX_FULL_GROUP_MEMBERS);
    }

    #[test]
    fn source_selection_caps_examined_hidden_edges() {
        let edge_count = MAX_SUBGRAPH_EDGES * 2;
        let edges: Vec<Edge> = (0..edge_count)
            .map(|bit| Edge {
                from: 0,
                to: 1,
                from_port: "1'b0".to_owned(),
                to_port: "A".to_owned(),
                to_port_bit: bit as u32,
                bit: Some(bit as u32),
                net_name: "hidden".to_owned(),
                control: false,
            })
            .collect();
        let graph = graph_from_parts(
            "hidden_edges",
            vec![
                constant_node(0, "1'b0"),
                combinational_node(1, "$and", Some("source.sv:10")),
            ],
            edges,
            vec![(0..edge_count).collect(), Vec::new()],
            vec![Vec::new(), (0..edge_count).collect()],
        );
        let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("source.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "source.sv",
                    start_line: 10,
                    end_line: 10,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();

        assert!(result.graph.truncated);
        assert_eq!(result.graph.nodes.len(), 1);
        assert!(result.graph.edges.is_empty());
    }

    #[test]
    fn source_selection_queries_sparse_targets_in_a_large_procedural_block() {
        let graph = source_selection_fixture();
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 1,
            start_column: None,
            end_line: 1_000_000_000,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Block,
        }]);
        analysis.set_procedural_targets(HashMap::from([(
            ("top.sv".to_owned(), 999_999_999),
            vec![1],
        )]));
        let started = Instant::now();

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 500_000_000,
                    end_line: 500_000_000,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();

        assert!(started.elapsed().as_secs() < 1);
        assert_eq!(result.status, SourceSelectionStatus::Mapped);
        assert_eq!(
            result
                .graph
                .nodes
                .iter()
                .filter(|node| node.is_root == Some(true))
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![1]
        );
    }

    #[test]
    fn source_selection_caps_duplicate_procedural_target_visits() {
        let graph = source_selection_fixture();
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        let end_line = SOURCE_PROBE_TARGET_VISIT_CAP * 2;
        analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 1,
            start_column: None,
            end_line,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Block,
        }]);
        analysis.set_procedural_targets(
            (1..=end_line)
                .map(|line| (("top.sv".to_owned(), line), vec![1]))
                .collect(),
        );
        let started = Instant::now();

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 1,
                    end_line: 1,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();

        assert!(started.elapsed().as_secs() < 1);
        assert!(result.graph.truncated);
        assert_eq!(result.status, SourceSelectionStatus::Mapped);
        assert_eq!(
            result
                .graph
                .nodes
                .iter()
                .filter(|node| node.is_root == Some(true))
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![1]
        );
    }

    #[test]
    fn source_selection_preserves_validation_precedence() {
        let graph = source_selection_fixture();
        let analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        let source_index = empty_source_index("top.sv");
        let select = |file, start_line, end_line| {
            analysis.source_selection(
                &graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file,
                    start_line,
                    end_line,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
        };

        assert_eq!(
            select("missing.sv", 0, 0).unwrap_err(),
            SourceSelectionError::UnknownFile
        );
        assert_eq!(
            select("top.sv", 0, 0).unwrap_err(),
            SourceSelectionError::InvalidRange
        );
        assert_eq!(
            select("top.sv", 1, 201).unwrap_err(),
            SourceSelectionError::TooManyLines
        );
    }

    #[test]
    fn source_selection_honors_directional_hints_and_legacy_envelopes() {
        let mut fanin_graph = source_selection_fixture();
        fanin_graph.nodes[1].src = Some("top.sv:4".to_owned());
        let mut fanin_analysis = Analysis::new(&fanin_graph, vec!["top.sv".to_owned()]);
        fanin_analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 4,
            start_column: None,
            end_line: 4,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Signal,
        }]);
        let source_index = empty_source_index("top.sv");
        let fanin = fanin_analysis
            .source_selection(
                &fanin_graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 4,
                    end_line: 4,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();
        assert_eq!(
            fanin
                .graph
                .nodes
                .iter()
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(fanin.direct_ids, vec![1]);

        let mut fanout_graph = source_selection_fixture();
        fanout_graph.nodes[0].src = Some("top.sv:2".to_owned());
        let mut fanout_analysis = Analysis::new(&fanout_graph, vec!["top.sv".to_owned()]);
        fanout_analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 2,
            start_column: None,
            end_line: 2,
            end_column: None,
            direction: SourceProbeDirection::Fanout,
            kind: SourceProbeHintKind::Signal,
        }]);
        let fanout = fanout_analysis
            .source_selection(
                &fanout_graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 2,
                    end_line: 2,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();
        assert_eq!(
            fanout
                .graph
                .nodes
                .iter()
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(fanout.graph.nodes[2].is_boundary, Some(true));

        let mut envelope_graph = source_selection_fixture();
        envelope_graph.nodes[1].src = Some("top.sv:7".to_owned());
        let envelope_analysis = Analysis::new(&envelope_graph, vec!["top.sv".to_owned()]);
        let envelope = envelope_analysis
            .source_selection(
                &envelope_graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 7,
                    end_line: 7,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();
        assert_eq!(
            envelope
                .graph
                .nodes
                .iter()
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[test]
    fn source_selection_narrows_block_attribution_to_the_assignment_target() {
        let mut first = combinational_node(0, "$dff", Some("top.sv:8.1-14.3"));
        first.seq = true;
        let mut second = combinational_node(1, "$dff", Some("top.sv:8.1-14.3"));
        second.seq = true;
        let graph = graph_from_parts(
            "procedural",
            vec![first, second],
            Vec::new(),
            vec![Vec::new(), Vec::new()],
            vec![Vec::new(), Vec::new()],
        );
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.set_procedural_targets(HashMap::from([(("top.sv".to_owned(), 10), vec![0])]));
        analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 10,
            start_column: None,
            end_line: 10,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Procedural,
        }]);

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 10,
                    end_line: 10,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();
        assert_eq!(
            result
                .graph
                .nodes
                .iter()
                .filter(|node| node.is_root == Some(true))
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![0]
        );
    }

    #[test]
    fn source_selection_distinguishes_optimized_source_from_unmapped_text() {
        let graph = source_selection_fixture();
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        let mut source_index = empty_source_index("top.sv");
        let seen = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 20,
            end_line: 20,
            start_column: None,
            end_column: None,
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };
        source_index.extend_ranges([&seen]);
        analysis.extend_source_ranges(
            vec![SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 22,
                end_line: 22,
                start_column: Some(7),
                end_column: Some(16),
                node_ids: Vec::new(),
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            }],
            false,
        );

        let status = |line| {
            analysis
                .source_selection(
                    &graph,
                    &source_index,
                    &GroupPartition::default(),
                    SourceSelectionRange {
                        file: "top.sv",
                        start_line: line,
                        end_line: line,
                        start_column: None,
                        end_column: None,
                    },
                    selection_options(),
                )
                .unwrap()
                .status
        };
        assert_eq!(status(20), SourceSelectionStatus::OptimizedOrAbsorbed);
        assert_eq!(status(21), SourceSelectionStatus::Unmapped);
        let optimized_declaration = analysis
            .source_selection(
                &graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 22,
                    end_line: 22,
                    start_column: Some(1),
                    end_column: Some(1),
                },
                selection_options(),
            )
            .unwrap();
        assert_eq!(
            optimized_declaration.status,
            SourceSelectionStatus::Unmapped
        );
    }

    #[test]
    fn source_selection_reports_aggregate_direct_bit_truncation() {
        let graph = source_selection_fixture();
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            (0..=SOURCE_ROOT_COLLECTION_CAP)
                .map(|bit| SourceRangeMapping {
                    file: "top.sv".to_owned(),
                    start_line: 30,
                    end_line: 30,
                    start_column: None,
                    end_column: None,
                    node_ids: Vec::new(),
                    signal_bits: vec![bit as u32],
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                })
                .collect(),
            false,
        );

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 30,
                    end_line: 30,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();

        assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
        assert_eq!(result.direct_bits.len(), SOURCE_ROOT_COLLECTION_CAP);
    }

    #[test]
    fn bit_to_source_query_is_independent_of_the_bulk_source_map_cap() {
        let graph = source_selection_fixture();
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        let target_line = SOURCE_RANGE_RESPONSE_CAP + 1;
        analysis.extend_source_ranges(
            (1..=target_line)
                .map(|line| SourceRangeMapping {
                    file: "top.sv".to_owned(),
                    start_line: line,
                    end_line: line,
                    start_column: Some(7),
                    end_column: Some(12),
                    node_ids: Vec::new(),
                    signal_bits: vec![if line == target_line { 99 } else { 1 }],
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                })
                .collect(),
            false,
        );

        let bulk = analysis.source_map();
        assert!(bulk.truncated);
        assert!(
            !bulk
                .ranges
                .iter()
                .any(|range| range.start_line == target_line)
        );
        let reverse = analysis.source_ranges_for_bits(&[99]);
        assert!(!reverse.truncated);
        assert_eq!(reverse.ranges.len(), 1);
        assert_eq!(reverse.ranges[0].start_line, target_line);
        assert!(reverse.ranges[0].node_ids.is_empty());
        assert!(reverse.ranges[0].signal_bits.is_empty());
    }

    #[test]
    fn bit_to_source_query_reports_incomplete_provenance() {
        let graph = source_selection_fixture();
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 2,
                end_line: 2,
                start_column: Some(7),
                end_column: Some(12),
                node_ids: vec![1],
                signal_bits: vec![99],
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: true,
            }],
            false,
        );

        let reverse = analysis.source_ranges_for_bits(&[99]);
        assert!(reverse.truncated);
        assert!(!reverse.approximate);
        assert_eq!(reverse.ranges.len(), 1);
        assert!(reverse.ranges[0].mapping_incomplete);

        analysis.extend_source_ranges(Vec::new(), true);
        assert!(analysis.source_ranges_for_bits(&[99]).truncated);
    }

    #[test]
    fn bit_to_source_query_deduplicates_input_and_orders_exact_and_approximate_ranges() {
        let graph = source_selection_fixture();
        let mut analysis = Analysis::new(&graph, vec!["z.sv".to_owned(), "a.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![
                SourceRangeMapping {
                    file: "z.sv".to_owned(),
                    start_line: 5,
                    end_line: 5,
                    start_column: None,
                    end_column: None,
                    node_ids: vec![2],
                    signal_bits: Vec::new(),
                    approximate_signal_bits: vec![9],
                    mapping_incomplete: false,
                },
                SourceRangeMapping {
                    file: "a.sv".to_owned(),
                    start_line: 9,
                    end_line: 9,
                    start_column: Some(7),
                    end_column: Some(12),
                    node_ids: vec![1],
                    signal_bits: vec![9],
                    approximate_signal_bits: vec![7],
                    mapping_incomplete: false,
                },
                SourceRangeMapping {
                    file: "a.sv".to_owned(),
                    start_line: 3,
                    end_line: 3,
                    start_column: Some(2),
                    end_column: Some(4),
                    node_ids: vec![0],
                    signal_bits: vec![7],
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                },
            ],
            false,
        );

        let reverse = analysis.source_ranges_for_bits(&[9, 7, 9, 7]);

        assert!(!reverse.truncated);
        assert!(reverse.approximate);
        assert_eq!(
            reverse
                .ranges
                .iter()
                .map(|range| (range.file.as_str(), range.start_line))
                .collect::<Vec<_>>(),
            vec![("a.sv", 3), ("a.sv", 9), ("z.sv", 5)]
        );
        assert!(reverse.ranges.iter().all(|range| {
            range.node_ids.is_empty()
                && range.signal_bits.is_empty()
                && range.approximate_signal_bits.is_empty()
        }));
        assert_eq!(reverse.ranges[0].start_column, Some(2));
        assert_eq!(reverse.ranges[1].end_column, Some(12));
        assert_eq!(reverse.ranges[2].start_column, None);
    }

    #[test]
    fn source_selection_reports_global_source_mapping_truncation() {
        let graph = source_selection_fixture();
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(Vec::new(), true);

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 21,
                    end_line: 21,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();

        assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
    }

    #[test]
    fn source_spans_use_inclusive_columns_and_whole_line_fallbacks() {
        let precise = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 2,
            end_line: 2,
            start_column: Some(7),
            end_column: Some(16),
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };
        assert!(source_spans_overlap(&precise, 2, 2, Some(10), Some(10)));
        assert!(!source_spans_overlap(&precise, 2, 2, Some(6), Some(6)));
        assert!(!source_spans_overlap(&precise, 2, 2, Some(17), Some(17)));
        let whole_line = SourceRangeMapping {
            start_column: None,
            end_column: None,
            ..precise
        };
        assert!(source_spans_overlap(
            &whole_line,
            2,
            2,
            Some(100),
            Some(100)
        ));
        assert_eq!(
            parse_src_span("top.sv:2.7-4.12"),
            Some(("top.sv".to_owned(), 2, Some(7), 4, Some(12)))
        );
    }

    #[test]
    fn source_span_parser_keeps_valid_fragments_and_normalizes_existing_edge_cases() {
        assert_eq!(
            parse_src_span("  /tmp/generated/top.sv:5.7-6.11  "),
            Some(("top.sv".to_owned(), 5, Some(7), 6, Some(11)))
        );
        assert_eq!(
            parse_src_span("top.sv:8.3-7.2"),
            Some(("top.sv".to_owned(), 8, Some(3), 8, Some(3)))
        );
        assert_eq!(
            parse_src_span(r"C:\rtl\top.sv:2.1-2.4"),
            Some((r"C:\rtl\top.sv".to_owned(), 2, Some(1), 2, Some(4)))
        );
        for malformed in [
            "garbage",
            "top.sv:not-a-line",
            "top.sv:2.bad-2.4",
            "top.sv:2.1-4.bad",
        ] {
            assert_eq!(parse_src_span(malformed), None, "fragment: {malformed}");
        }

        let mut retained = Vec::new();
        insert_src_lines(
            "garbage|/tmp/generated/top.sv:5.7-5.11|top.sv:not-a-line|top.sv:8.3-7.2",
            |file, line| retained.push((file.to_owned(), line)),
        );
        assert_eq!(
            retained,
            vec![("top.sv".to_owned(), 5), ("top.sv".to_owned(), 8)]
        );
    }

    #[test]
    fn duplicate_source_spans_do_not_consume_the_distinct_span_budget() {
        let duplicate = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 2,
            end_line: 2,
            start_column: Some(7),
            end_column: Some(12),
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };
        let distinct = SourceRangeMapping {
            start_line: 3,
            end_line: 3,
            ..duplicate.clone()
        };
        let mut index = SourceLineIndex {
            files: HashSet::from(["top.sv".to_owned()]),
            lines: HashSet::new(),
            recovered_ranges: BTreeMap::new(),
            spans: BTreeMap::from([(
                "top.sv".to_owned(),
                SourceSpanIndex {
                    spans: vec![SourceSpanInterval {
                        start_line: duplicate.start_line,
                        start_column: duplicate.start_column,
                        end_line: duplicate.end_line,
                        end_column: duplicate.end_column,
                    }],
                    prefix_max_end_line: vec![duplicate.end_line],
                },
            )]),
            span_count: SOURCE_SPAN_INDEX_CAP - 1,
            incomplete_span_files: HashSet::new(),
        };

        index.extend_ranges([&duplicate, &distinct]);

        assert_eq!(index.span_count, SOURCE_SPAN_INDEX_CAP);
        assert_eq!(
            index.contains_span("top.sv", 3, 3, Some(8), Some(8)),
            Some(true)
        );
    }

    #[test]
    fn source_span_index_reports_omitted_distinct_spans() {
        let mut index = SourceLineIndex {
            files: HashSet::from(["top.sv".to_owned()]),
            lines: HashSet::new(),
            recovered_ranges: BTreeMap::new(),
            spans: BTreeMap::new(),
            span_count: SOURCE_SPAN_INDEX_CAP,
            incomplete_span_files: HashSet::new(),
        };
        let omitted = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 9,
            end_line: 9,
            start_column: Some(3),
            end_column: Some(8),
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };

        index.extend_ranges([&omitted]);

        assert!(index.span_mapping_incomplete("top.sv"));
        let graph = source_selection_fixture();
        let result = Analysis::new(&graph, vec!["top.sv".to_owned()])
            .source_selection(
                &graph,
                &index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 9,
                    end_line: 9,
                    start_column: Some(4),
                    end_column: Some(4),
                },
                selection_options(),
            )
            .unwrap();
        assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
    }

    #[test]
    fn analysis_source_range_index_rejects_overflow() {
        let graph = sourced_node_graph(1);
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        let ranges = (1..=SOURCE_RANGE_INDEX_CAP + 1)
            .map(|line| SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: line,
                end_line: line,
                start_column: Some(1),
                end_column: Some(2),
                node_ids: Vec::new(),
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            })
            .collect();

        analysis.extend_source_ranges(ranges, false);

        assert_eq!(
            analysis
                .source_ranges
                .values()
                .map(|index| index.ranges.len())
                .sum::<usize>(),
            SOURCE_RANGE_INDEX_CAP
        );
        assert!(analysis.source_map.truncated);
    }

    #[test]
    fn source_selection_distinguishes_same_line_node_spans() {
        let graph = graph_from_parts(
            "same_line_nodes",
            vec![
                combinational_node(0, "$and", Some("top.sv:5.1-5.12")),
                combinational_node(1, "$or", Some("top.sv:5.20-5.30")),
            ],
            Vec::new(),
            vec![Vec::new(); 2],
            vec![Vec::new(); 2],
        );
        let analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        let select = |column| {
            analysis
                .source_selection(
                    &graph,
                    &empty_source_index("top.sv"),
                    &GroupPartition::default(),
                    SourceSelectionRange {
                        file: "top.sv",
                        start_line: 5,
                        end_line: 5,
                        start_column: Some(column),
                        end_column: Some(column),
                    },
                    selection_options(),
                )
                .unwrap()
        };

        assert_eq!(select(6).direct_ids, vec![0]);
        assert_eq!(select(25).direct_ids, vec![1]);
        assert_eq!(select(16).status, SourceSelectionStatus::Unmapped);
    }

    #[test]
    fn precise_mapping_does_not_hide_native_nodes_on_other_selected_lines() {
        let graph = graph_from_parts(
            "mixed_source_ranges",
            vec![
                combinational_node(0, "$and", Some("top.sv:5.1-5.12")),
                combinational_node(1, "$or", Some("top.sv:6.1-6.12")),
            ],
            Vec::new(),
            vec![Vec::new(); 2],
            vec![Vec::new(); 2],
        );
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: Some(1),
                end_column: Some(12),
                node_ids: vec![0],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            }],
            false,
        );

        assert_eq!(
            analysis.source_nodes_range(&graph, "top.sv", 5, 6, Some(1), Some(12)),
            Some(vec![0, 1])
        );
    }

    #[test]
    fn collapsed_caret_falls_back_to_the_nearest_span_inside_its_statement() {
        let graph = graph_from_parts(
            "nearest_declaration",
            vec![
                combinational_node(0, "$and", None),
                combinational_node(1, "$or", None),
            ],
            Vec::new(),
            vec![Vec::new(); 2],
            vec![Vec::new(); 2],
        );
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![
                SourceRangeMapping {
                    file: "top.sv".to_owned(),
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(7),
                    end_column: Some(11),
                    node_ids: vec![0],
                    signal_bits: Vec::new(),
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                },
                SourceRangeMapping {
                    file: "top.sv".to_owned(),
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(20),
                    end_column: Some(25),
                    node_ids: vec![1],
                    signal_bits: Vec::new(),
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                },
            ],
            false,
        );
        let select = |column, fallback_columns| {
            analysis
                .source_selection_with_fallback(
                    &graph,
                    &empty_source_index("top.sv"),
                    &GroupPartition::default(),
                    SourceSelectionRange {
                        file: "top.sv",
                        start_line: 5,
                        end_line: 5,
                        start_column: Some(column),
                        end_column: Some(column),
                    },
                    Some(fallback_columns),
                    selection_options(),
                )
                .unwrap()
                .direct_ids
        };

        assert_eq!(select(1, (1, 12)), vec![0]);
        assert_eq!(select(14, (13, 26)), vec![1]);
        assert!(select(14, (13, 18)).is_empty());
        assert_eq!(select(22, (1, 26)), vec![1]);
    }

    #[test]
    fn exact_optimized_span_does_not_fall_through_to_a_mapped_neighbor() {
        let graph = graph_from_parts(
            "optimized_neighbor",
            vec![combinational_node(0, "$and", None)],
            Vec::new(),
            vec![Vec::new()],
            vec![Vec::new()],
        );
        let optimized = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 5,
            end_line: 5,
            start_column: Some(7),
            end_column: Some(11),
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };
        let mapped = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 5,
            end_line: 5,
            start_column: Some(20),
            end_column: Some(25),
            node_ids: vec![0],
            signal_bits: vec![42],
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(vec![mapped.clone(), optimized.clone()], false);
        let mut source_index = empty_source_index("top.sv");
        source_index.extend_ranges([&mapped, &optimized]);

        let result = analysis
            .source_selection_with_fallback(
                &graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(9),
                    end_column: Some(9),
                },
                Some((1, 30)),
                selection_options(),
            )
            .unwrap();

        assert_eq!(result.status, SourceSelectionStatus::OptimizedOrAbsorbed);
        assert!(result.direct_ids.is_empty());
        assert!(result.direct_bits.is_empty());
        assert!(result.graph.nodes.is_empty());
    }

    #[test]
    fn fallback_ties_are_stable_and_only_apply_to_valid_collapsed_carets() {
        let graph = graph_from_parts(
            "fallback_boundaries",
            vec![
                combinational_node(0, "$and", None),
                combinational_node(1, "$or", None),
            ],
            Vec::new(),
            vec![Vec::new(); 2],
            vec![Vec::new(); 2],
        );
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![
                SourceRangeMapping {
                    file: "top.sv".to_owned(),
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(7),
                    end_column: Some(9),
                    node_ids: vec![0],
                    signal_bits: Vec::new(),
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                },
                SourceRangeMapping {
                    file: "top.sv".to_owned(),
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(13),
                    end_column: Some(15),
                    node_ids: vec![1],
                    signal_bits: Vec::new(),
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                },
            ],
            false,
        );
        let select = |selection, fallback_columns| {
            analysis
                .source_selection_with_fallback(
                    &graph,
                    &empty_source_index("top.sv"),
                    &GroupPartition::default(),
                    selection,
                    fallback_columns,
                    selection_options(),
                )
                .unwrap()
        };
        let caret = |column| SourceSelectionRange {
            file: "top.sv",
            start_line: 5,
            end_line: 5,
            start_column: Some(column),
            end_column: Some(column),
        };

        assert_eq!(select(caret(11), Some((1, 20))).direct_ids, vec![0]);
        assert_eq!(select(caret(11), Some((10, 20))).direct_ids, vec![1]);
        assert!(select(caret(11), Some((12, 20))).direct_ids.is_empty());
        assert!(select(caret(11), None).direct_ids.is_empty());
        assert!(
            select(
                SourceSelectionRange {
                    start_column: Some(10),
                    end_column: Some(11),
                    ..caret(10)
                },
                Some((1, 20)),
            )
            .direct_ids
            .is_empty()
        );
        assert!(
            select(
                SourceSelectionRange {
                    start_line: 5,
                    end_line: 6,
                    start_column: Some(16),
                    end_column: Some(1),
                    ..caret(16)
                },
                Some((1, 20)),
            )
            .direct_ids
            .is_empty()
        );
    }

    #[test]
    fn node_ref_unions_deduplicates_and_orders_native_and_synthetic_sources() {
        let graph = graph_from_parts(
            "source_union",
            vec![combinational_node(
                0,
                "$and",
                Some("top.sv:9.1-9.3|top.sv:2.1-2.3|top.sv:9.1-9.3"),
            )],
            Vec::new(),
            vec![Vec::new()],
            vec![Vec::new()],
        );
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![
                SourceRangeMapping {
                    file: "top.sv".to_owned(),
                    start_line: 4,
                    end_line: 4,
                    start_column: Some(7),
                    end_column: Some(8),
                    node_ids: vec![0],
                    signal_bits: Vec::new(),
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                },
                SourceRangeMapping {
                    file: "top.sv".to_owned(),
                    start_line: 2,
                    end_line: 2,
                    start_column: Some(1),
                    end_column: Some(3),
                    node_ids: vec![0],
                    signal_bits: Vec::new(),
                    approximate_signal_bits: Vec::new(),
                    mapping_incomplete: false,
                },
            ],
            false,
        );

        assert_eq!(
            analysis.node_ref(&graph, 0).src.as_deref(),
            Some("top.sv:2.1-2.3|top.sv:4.7-4.8|top.sv:9.1-9.3")
        );
    }

    #[test]
    fn exact_native_mapping_wins_when_the_auxiliary_span_index_is_incomplete() {
        let graph = graph_from_parts(
            "exact_native",
            vec![
                combinational_node(0, "$and", Some("top.sv:5.7-5.11")),
                combinational_node(1, "$or", None),
            ],
            Vec::new(),
            vec![Vec::new(); 2],
            vec![Vec::new(); 2],
        );
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: Some(20),
                end_column: Some(25),
                node_ids: vec![1],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            }],
            false,
        );
        let mut source_index = empty_source_index("top.sv");
        source_index
            .incomplete_span_files
            .insert("top.sv".to_owned());

        let result = analysis
            .source_selection_with_fallback(
                &graph,
                &source_index,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(9),
                    end_column: Some(9),
                },
                Some((1, 26)),
                selection_options(),
            )
            .unwrap();

        assert_eq!(result.direct_ids, vec![0]);
        assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
    }

    #[test]
    fn bidirectional_source_probe_uses_a_local_neighborhood() {
        let graph = deep_chain_graph(10);
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: Some(7),
                end_column: Some(16),
                node_ids: vec![5],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            }],
            false,
        );
        analysis.set_source_probe_hints(vec![
            SourceProbeHint {
                file: "top.sv".to_owned(),
                start_line: 5,
                start_column: Some(7),
                end_line: 5,
                end_column: Some(16),
                direction: SourceProbeDirection::Fanin,
                kind: SourceProbeHintKind::Signal,
            },
            SourceProbeHint {
                file: "top.sv".to_owned(),
                start_line: 5,
                start_column: Some(7),
                end_line: 5,
                end_column: Some(16),
                direction: SourceProbeDirection::Fanout,
                kind: SourceProbeHintKind::Signal,
            },
        ]);

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(10),
                    end_column: Some(10),
                },
                selection_options(),
            )
            .unwrap();

        assert_eq!(
            result
                .graph
                .nodes
                .iter()
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![4, 5, 6]
        );
    }

    #[test]
    fn legacy_no_hint_source_probe_retains_its_deep_envelope() {
        let graph = deep_chain_graph(10);
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(
            vec![SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: Some(7),
                end_column: Some(16),
                node_ids: vec![5],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            }],
            false,
        );

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(10),
                    end_column: Some(10),
                },
                selection_options(),
            )
            .unwrap();

        assert_eq!(
            result
                .graph
                .nodes
                .iter()
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            (0..graph.nodes.len() as u32).collect::<Vec<_>>()
        );
    }

    #[test]
    fn source_selection_expands_a_direct_output_register_through_its_data_input() {
        let mut register = combinational_node(2, "$dff", None);
        register.seq = true;
        register.name = "registered".to_owned();
        let mut output = port_node(3, "y", PortDirection::Output);
        output.src = Some("top.sv:5".to_owned());
        let nodes = vec![
            port_node(0, "a", PortDirection::Input),
            combinational_node(1, "$and", None),
            register,
            output,
        ];
        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); nodes.len()];
        let mut incoming = vec![Vec::new(); nodes.len()];
        for (from, to, from_port, to_port) in [(0, 1, "a", "A"), (1, 2, "Y", "D"), (2, 3, "Q", "y")]
        {
            let index = edges.len();
            edges.push(Edge {
                from,
                to,
                from_port: from_port.to_owned(),
                to_port: to_port.to_owned(),
                to_port_bit: 0,
                bit: Some(index as u32),
                net_name: format!("n{index}"),
                control: false,
            });
            outgoing[from as usize].push(index);
            incoming[to as usize].push(index);
        }
        let graph = graph_from_parts("registered_output", nodes, edges, outgoing, incoming);
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 5,
            start_column: None,
            end_line: 5,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::OutputPort,
        }]);

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();
        assert_eq!(
            result
                .graph
                .nodes
                .iter()
                .map(|node| node.node.id)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn source_selection_keeps_visible_controls_for_dependency_registers() {
        let mut register = combinational_node(2, "$dff", None);
        register.seq = true;
        register.name = "registered".to_owned();
        let mut output = port_node(3, "y", PortDirection::Output);
        output.src = Some("top.sv:5".to_owned());
        let nodes = vec![
            port_node(0, "a", PortDirection::Input),
            combinational_node(1, "$and", None),
            register,
            output,
            port_node(4, "clk", PortDirection::Input),
            port_node(5, "rst", PortDirection::Input),
        ];
        let connections = [
            (0, 1, "a", "A", false),
            (2, 1, "Q", "B", false),
            (1, 3, "Y", "y", false),
            (4, 2, "clk", "C", true),
            (5, 2, "rst", "R", true),
        ];
        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); nodes.len()];
        let mut incoming = vec![Vec::new(); nodes.len()];
        for (from, to, from_port, to_port, control) in connections {
            let index = edges.len();
            edges.push(Edge {
                from,
                to,
                from_port: from_port.to_owned(),
                to_port: to_port.to_owned(),
                to_port_bit: 0,
                bit: Some(index as u32),
                net_name: from_port.to_owned(),
                control,
            });
            outgoing[from as usize].push(index);
            incoming[to as usize].push(index);
        }
        let graph = graph_from_parts(
            "registered_output_controls",
            nodes,
            edges,
            outgoing,
            incoming,
        );
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 5,
            start_column: None,
            end_line: 5,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::OutputPort,
        }]);

        let result = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: None,
                    end_column: None,
                },
                SourceSelectionOptions {
                    hide_control: false,
                    ..selection_options()
                },
            )
            .unwrap();

        assert!(
            result
                .graph
                .nodes
                .iter()
                .any(|node| node.node.name == "clk")
        );
        assert!(
            result
                .graph
                .nodes
                .iter()
                .any(|node| node.node.name == "rst")
        );
        assert!(
            result
                .graph
                .edges
                .iter()
                .any(|edge| { edge.to == 2 && edge.to_port == "C" && edge.control == Some(true) })
        );
        assert!(
            result
                .graph
                .edges
                .iter()
                .any(|edge| { edge.to == 2 && edge.to_port == "R" && edge.control == Some(true) })
        );

        let hidden = analysis
            .source_selection(
                &graph,
                &empty_source_index("top.sv"),
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap();
        assert!(
            hidden
                .graph
                .nodes
                .iter()
                .all(|node| !matches!(node.node.name.as_str(), "clk" | "rst"))
        );
        assert!(
            hidden
                .graph
                .edges
                .iter()
                .all(|edge| edge.control != Some(true))
        );
    }

    #[test]
    fn source_selection_projects_groups_and_prioritizes_incomplete_mapping() {
        let graph = graph_from_parts(
            "grouped_source",
            vec![
                port_node(0, "a", PortDirection::Input),
                combinational_node(1, "$and", Some("top.sv:9-12")),
                port_node(2, "y", PortDirection::Output),
                combinational_node(3, "$and", Some("top.sv:9-12")),
            ],
            Vec::new(),
            vec![Vec::new(); 4],
            vec![Vec::new(); 4],
        );
        let range = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 9,
            start_column: None,
            end_line: 9,
            end_column: None,
            node_ids: vec![1, 3],
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: true,
        };
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(vec![range.clone()], false);
        analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 9,
            start_column: None,
            end_line: 9,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Signal,
        }]);
        let grouping = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Comb,
                members: vec![1, 3],
                label: "logic[1:0]".to_owned(),
                cell_type: "$and".to_owned(),
            }],
            group_of: HashMap::from([(1, 0), (3, 0)]),
        };
        let mut source_index = empty_source_index("top.sv");
        source_index.extend_ranges([&range]);

        let result = analysis
            .source_selection(
                &graph,
                &source_index,
                &grouping,
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 9,
                    end_line: 9,
                    start_column: None,
                    end_column: None,
                },
                SourceSelectionOptions {
                    group_vectors: true,
                    ..selection_options()
                },
            )
            .unwrap();

        assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
        assert_eq!(result.graph.nodes.len(), 1);
        let group = &result.graph.nodes[0];
        assert_eq!(group.node.id, 4);
        assert_eq!(group.node.name, "logic[1:0]");
        assert_eq!(group.node.src.as_deref(), Some("top.sv:9-12|top.sv:9-9"));
        assert_eq!(group.is_root, Some(true));
        assert_eq!(group.width, Some(2));
        assert_eq!(group.members.as_deref(), Some(&[1, 3][..]));
        assert_eq!(result.direct_ids, vec![4]);
        assert!(group.controls.is_empty());
    }

    #[test]
    fn source_selection_preserves_recovered_metadata_on_grouped_ports() {
        let graph = graph_from_parts(
            "grouped_ports",
            vec![
                port_node(0, "a[0]", PortDirection::Input),
                port_node(1, "a[1]", PortDirection::Input),
            ],
            Vec::new(),
            vec![Vec::new(); 2],
            vec![Vec::new(); 2],
        );
        let range = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 2,
            end_line: 2,
            start_column: None,
            end_column: None,
            node_ids: vec![0, 1],
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };
        let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
        analysis.extend_source_ranges(vec![range.clone()], false);
        let grouping = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Port,
                members: vec![0, 1],
                label: "a[1:0]".to_owned(),
                cell_type: String::new(),
            }],
            group_of: HashMap::from([(0, 0), (1, 0)]),
        };
        let mut source_index = empty_source_index("top.sv");
        source_index.extend_ranges([&range]);

        let result = analysis
            .source_selection(
                &graph,
                &source_index,
                &grouping,
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 2,
                    end_line: 2,
                    start_column: None,
                    end_column: None,
                },
                SourceSelectionOptions {
                    group_vectors: true,
                    ..selection_options()
                },
            )
            .unwrap();

        assert_eq!(result.graph.nodes.len(), 1);
        let group = &result.graph.nodes[0];
        assert_eq!(group.node.id, 2);
        assert_eq!(group.node.name, "a[1:0]");
        assert_eq!(group.node.src.as_deref(), Some("top.sv:2-2"));
        assert_eq!(group.width, Some(2));
        assert!(group.controls.is_empty());
    }

    #[test]
    fn grouped_source_fragment_cap_marks_the_projection_truncated() {
        let graph = graph_from_parts(
            "grouped_src_cap",
            (0..9)
                .map(|id| {
                    let mut node = combinational_node(id, "$and", None);
                    node.src = Some(format!("top.sv:{}", id + 1));
                    node
                })
                .collect(),
            Vec::new(),
            vec![Vec::new(); 9],
            vec![Vec::new(); 9],
        );
        let partition = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Comb,
                members: (0..9).collect(),
                label: "logic[8:0]".to_owned(),
                cell_type: "$and".to_owned(),
            }],
            group_of: (0..9).map(|id| (id, 0)).collect(),
        };
        let subgraph = Subgraph {
            nodes: (0..9)
                .map(|id| GraphNode {
                    node: node_ref(&graph, id),
                    is_root: None,
                    is_boundary: None,
                    depth: None,
                    params: BTreeMap::new(),
                    controls: Vec::new(),
                    width: None,
                    member_count: None,
                    members: None,
                })
                .collect(),
            edges: Vec::new(),
            truncated: false,
        };

        let grouped = quotient_subgraph(&graph, subgraph, GroupingProjection::all(&partition));

        assert!(grouped.truncated);
        assert_eq!(
            grouped.nodes[0]
                .node
                .src
                .as_deref()
                .unwrap()
                .split('|')
                .count(),
            8
        );
    }

    #[test]
    fn source_range_roots_use_a_sentinel_and_propagate_truncation() {
        let graph = sourced_node_graph(SOURCE_ROOT_COLLECTION_CAP + 500);
        let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
        let roots = analysis
            .source_nodes_range(&graph, "source.sv", 1, 1, None, None)
            .unwrap();

        assert_eq!(roots.len(), SOURCE_ROOT_COLLECTION_CAP);
        assert_eq!(roots.first(), Some(&0));
        assert_eq!(roots.last(), Some(&(MAX_SUBGRAPH_NODES as NodeId)));

        let envelope = analysis
            .envelope(
                &graph,
                &roots,
                ConeOptions {
                    dir: ConeDir::Fanin,
                    max_depth: 64,
                    max_nodes: 400,
                    hide_control: true,
                    hide_const: true,
                    show_infrastructure: true,
                    root_port: None,
                    root_port_bit: None,
                    root_port_bits: None,
                },
                None,
            )
            .unwrap();
        // Root units consume at most half the display budget so even a source
        // line with thousands of mapped nodes leaves room for graph context.
        assert_eq!(envelope.nodes.len(), 200);
        assert!(envelope.truncated);
    }

    #[test]
    fn sparse_recovered_span_uses_one_interval_for_queries_and_source_probe() {
        let graph = graph_from_parts(
            "sparse",
            vec![combinational_node(0, "$and", None)],
            Vec::new(),
            vec![Vec::new()],
            vec![Vec::new()],
        );
        let range = SourceRangeMapping {
            file: "sparse.sv".to_owned(),
            start_line: 2,
            start_column: None,
            end_line: 1_000_003,
            end_column: None,
            node_ids: vec![0],
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };
        let mut analysis = Analysis::new(&graph, vec!["sparse.sv".to_owned()]);
        analysis.extend_source_ranges(vec![range.clone()], false);
        analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "sparse.sv".to_owned(),
            start_line: 2,
            start_column: None,
            end_line: 1_000_003,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Signal,
        }]);

        assert_eq!(
            analysis.source_nodes_range(&graph, "sparse.sv", 500_000, 500_000, None, None),
            Some(vec![0])
        );
        let probe = analysis
            .source_probe_range(&graph, "sparse.sv", 500_000, 500_000, None, None)
            .unwrap();
        assert_eq!(probe.roots, [0]);
        assert_eq!(probe.direction, Some(ConeDir::Fanin));
        assert!(analysis.source_map.by_line.is_empty());
        assert_eq!(analysis.synthetic_src.len(), 1);
        assert_eq!(analysis.synthetic_src[&0].len(), 1);
        assert_eq!(
            analysis.node_ref(&graph, 0).src.as_deref(),
            Some("sparse.sv:2-1000003")
        );
        let public = analysis.source_map();
        assert_eq!(public.ranges, vec![range.clone()]);
        assert!(!public.truncated);

        let module = YosysModule {
            attributes: BTreeMap::new(),
            ports: BTreeMap::new(),
            cells: BTreeMap::new(),
            memories: BTreeMap::new(),
            netnames: BTreeMap::new(),
        };
        let mut source_index = SourceLineIndex::from_module(&module, vec!["sparse.sv".to_owned()]);
        source_index.extend_ranges([&range]);
        assert_eq!(
            source_index.contains_range("sparse.sv", 500_000, 500_000),
            Some(true)
        );
        assert_eq!(
            source_index.contains_range("sparse.sv", 1_000_004, 1_000_004),
            Some(false)
        );
    }

    #[test]
    fn source_line_index_uses_only_reachable_preflatten_modules() {
        let netlist = parse_str(include_str!("../tests/fixtures/preflatten_scopes.json")).unwrap();

        let index = SourceLineIndex::from_netlist(
            &netlist,
            "scoped_children",
            vec!["children.sv".to_owned()],
        );

        assert_eq!(index.contains_range("children.sv", 2, 2), Some(true));
        assert_eq!(index.contains_range("children.sv", 6, 6), Some(true));
        assert_eq!(index.contains_range("children.sv", 10, 10), Some(false));
    }

    #[test]
    fn public_source_ranges_are_bounded_and_report_truncation() {
        let graph = graph_from_parts("bounded", Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut analysis = Analysis::new(&graph, vec!["bounded.sv".to_owned()]);
        let ranges = (0..SOURCE_RANGE_RESPONSE_CAP + 5)
            .map(|line| SourceRangeMapping {
                file: "bounded.sv".to_owned(),
                start_line: line + 1,
                end_line: line + 1,
                start_column: None,
                end_column: None,
                node_ids: Vec::new(),
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            })
            .collect();
        analysis.extend_source_ranges(ranges, false);

        let public = analysis.source_map();
        assert_eq!(public.ranges.len(), SOURCE_RANGE_RESPONSE_CAP);
        assert!(public.truncated);
    }

    #[test]
    fn public_source_lines_are_bounded_without_cloning_the_full_index() {
        let node_count = SOURCE_LINE_RESPONSE_CAP + 5;
        let nodes = (0..node_count)
            .map(|id| {
                let source = format!("bounded.sv:{}", id + 1);
                combinational_node(id as NodeId, "$and", Some(&source))
            })
            .collect();
        let graph = graph_from_parts(
            "bounded_lines",
            nodes,
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        );
        let analysis = Analysis::new(&graph, vec!["bounded.sv".to_owned()]);
        assert_eq!(analysis.source_map.by_line.len(), node_count);

        let public = analysis.source_map();
        assert_eq!(public.by_line.len(), SOURCE_LINE_RESPONSE_CAP);
        assert!(public.truncated);
    }

    #[test]
    fn boundary_endpoint_catalog_is_bounded_and_stats_remain_complete() {
        let graph = boundary_cap_graph();
        let analysis = Analysis::new(&graph, vec!["boundary_cap.sv".to_owned()]);

        assert_eq!(analysis.endpoints.boundaries.len(), MAX_BOUNDARY_ENDPOINTS);
        assert!(analysis.endpoints.boundaries_truncated);
        assert!(analysis.endpoint_targets_truncated);
        assert_eq!(analysis.stats.max_depth, 1);
        assert!(analysis.paths(&graph, 1, None).truncated);
    }

    #[test]
    fn boundary_bit_catalog_is_bounded_and_marks_partial_ports() {
        let graph = boundary_bit_cap_graph();
        let analysis = Analysis::new(&graph, vec!["boundary_bit_cap.sv".to_owned()]);
        let wide = analysis
            .endpoints
            .boundaries
            .iter()
            .find(|endpoint| endpoint.port == "WIDE")
            .unwrap();
        assert_eq!(wide.width, MAX_BOUNDARY_ENDPOINT_BITS + 1);
        assert_eq!(wide.bits.len(), MAX_BOUNDARY_ENDPOINT_BITS);
        assert!(wide.bits_truncated);
        let late = analysis
            .endpoints
            .boundaries
            .iter()
            .find(|endpoint| endpoint.port == "LATE")
            .unwrap();
        assert_eq!(late.width, 1);
        assert!(late.bits.is_empty());
        assert!(late.bits_truncated);
        assert!(analysis.endpoints.boundaries_truncated);
        assert!(analysis.endpoint_targets_truncated);
    }

    fn boundary_bit_cap_graph() -> Graph {
        let nodes = vec![port_node(0, "in", PortDirection::Input), boundary_node(1)];
        let mut edges = Vec::with_capacity(MAX_BOUNDARY_ENDPOINT_BITS + 2);
        let mut outgoing = vec![Vec::new(); 2];
        let mut incoming = vec![Vec::new(); 2];
        for bit in 0..=MAX_BOUNDARY_ENDPOINT_BITS as u32 {
            let index = edges.len();
            edges.push(Edge {
                from: 0,
                to: 1,
                from_port: "in".to_owned(),
                to_port: "WIDE".to_owned(),
                to_port_bit: bit,
                bit: Some(bit),
                net_name: "wide".to_owned(),
                control: false,
            });
            outgoing[0].push(index);
            incoming[1].push(index);
        }
        let index = edges.len();
        edges.push(Edge {
            from: 0,
            to: 1,
            from_port: "in".to_owned(),
            to_port: "LATE".to_owned(),
            to_port_bit: 0,
            bit: Some(MAX_BOUNDARY_ENDPOINT_BITS as u32 + 1),
            net_name: "late".to_owned(),
            control: false,
        });
        outgoing[0].push(index);
        incoming[1].push(index);
        graph_from_parts("boundary_bit_cap", nodes, edges, outgoing, incoming)
    }

    fn boundary_cap_graph() -> Graph {
        let comb_id = (MAX_BOUNDARY_ENDPOINTS + 1) as NodeId;
        let deep_boundary_id = comb_id + 1;
        let node_count = deep_boundary_id as usize + 1;
        let mut nodes = Vec::with_capacity(node_count);
        nodes.push(port_node(0, "in", PortDirection::Input));
        for id in 1..=MAX_BOUNDARY_ENDPOINTS as NodeId {
            nodes.push(boundary_node(id));
        }
        nodes.push(combinational_node(comb_id, "$buf", None));
        nodes.push(boundary_node(deep_boundary_id));

        let mut edges = Vec::with_capacity(MAX_BOUNDARY_ENDPOINTS + 2);
        let mut outgoing = vec![Vec::new(); node_count];
        let mut incoming = vec![Vec::new(); node_count];
        let mut add_edge = |from: NodeId, to: NodeId, bit: u32| {
            let index = edges.len();
            edges.push(Edge {
                from,
                to,
                from_port: "Y".to_owned(),
                to_port: "D".to_owned(),
                to_port_bit: 0,
                bit: Some(bit),
                net_name: format!("n{bit}"),
                control: false,
            });
            outgoing[from as usize].push(index);
            incoming[to as usize].push(index);
        };
        for id in 1..=MAX_BOUNDARY_ENDPOINTS as NodeId {
            add_edge(0, id, id);
        }
        add_edge(0, comb_id, comb_id);
        add_edge(comb_id, deep_boundary_id, deep_boundary_id);
        graph_from_parts("boundary_cap", nodes, edges, outgoing, incoming)
    }

    fn boundary_node(id: NodeId) -> Node {
        Node {
            id,
            kind: NodeKind::Cell,
            name: format!("boundary_{id}"),
            raw_name: format!("boundary_{id}"),
            cell_type: Some("CUSTOM_BOUNDARY".to_owned()),
            seq: true,
            blackbox: true,
            src: None,
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: None,
        }
    }

    fn deep_chain_graph(depth: usize) -> Graph {
        let node_count = depth + 2;
        let mut nodes = Vec::with_capacity(node_count);
        nodes.push(Node {
            id: 0,
            kind: NodeKind::PortBit,
            name: "in".to_owned(),
            raw_name: "in".to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: Some("in".to_owned()),
            port_bit: Some(0),
            port_dir: Some(PortDirection::Input),
            const_value: None,
        });
        for idx in 0..depth {
            let id = (idx + 1) as NodeId;
            nodes.push(Node {
                id,
                kind: NodeKind::Cell,
                name: format!("buf_{idx}"),
                raw_name: format!("buf_{idx}"),
                cell_type: Some("$buf".to_owned()),
                seq: false,
                blackbox: false,
                src: None,
                params: BTreeMap::new(),
                port: None,
                port_bit: None,
                port_dir: None,
                const_value: None,
            });
        }
        let output_id = (depth + 1) as NodeId;
        nodes.push(Node {
            id: output_id,
            kind: NodeKind::PortBit,
            name: "out".to_owned(),
            raw_name: "out".to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: Some("out".to_owned()),
            port_bit: Some(0),
            port_dir: Some(PortDirection::Output),
            const_value: None,
        });

        let mut edges = Vec::with_capacity(depth + 1);
        let mut outgoing = vec![Vec::new(); node_count];
        let mut incoming = vec![Vec::new(); node_count];
        for idx in 0..=depth {
            let from = idx as NodeId;
            let to = (idx + 1) as NodeId;
            let edge_idx = edges.len();
            edges.push(Edge {
                from,
                to,
                from_port: if idx == 0 { "in" } else { "Y" }.to_owned(),
                to_port: if idx == depth { "out" } else { "A" }.to_owned(),
                to_port_bit: 0,
                bit: Some(idx as u32),
                net_name: format!("n{idx}"),
                control: false,
            });
            outgoing[from as usize].push(edge_idx);
            incoming[to as usize].push(edge_idx);
        }

        Graph {
            nodes,
            edges,
            outgoing,
            incoming,
            top: "deep_chain".to_owned(),
            net_names: HashMap::new(),
            net_aliases: HashMap::new(),
            cell_info: HashMap::new(),
            blackboxes: Vec::new(),
            signal_fanout: HashMap::new(),
            clock_network: Vec::new(),
        }
    }

    fn divergent_depth_delay_graph() -> Graph {
        let mut nodes = vec![
            port_node(0, "deep_in", PortDirection::Input),
            port_node(1, "slow_in", PortDirection::Input),
            combinational_node(2, "$and", None),
            combinational_node(3, "$and", None),
            combinational_node(4, "LUT6", None),
            combinational_node(5, "$and", None),
            port_node(6, "slow_output", PortDirection::Output),
            combinational_node(7, "$and", None),
            combinational_node(8, "$and", None),
            combinational_node(9, "$and", None),
            combinational_node(10, "$and", None),
            port_node(11, "deep_output", PortDirection::Output),
        ];
        for node in &mut nodes {
            if node.kind == NodeKind::PortBit {
                node.port_bit = Some(0);
            }
        }
        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); nodes.len()];
        let mut incoming = vec![Vec::new(); nodes.len()];
        for (bit, (from, to)) in [
            (0, 2),
            (2, 3),
            (3, 5),
            (1, 4),
            (4, 5),
            (5, 6),
            (0, 7),
            (7, 8),
            (8, 9),
            (9, 10),
            (10, 11),
        ]
        .into_iter()
        .enumerate()
        {
            let edge_idx = edges.len();
            edges.push(Edge {
                from,
                to,
                from_port: "Y".to_owned(),
                to_port: if nodes[to as usize].kind == NodeKind::PortBit {
                    nodes[to as usize].name.clone()
                } else {
                    "A".to_owned()
                },
                to_port_bit: 0,
                bit: Some(bit as u32),
                net_name: format!("n{bit}"),
                control: false,
            });
            outgoing[from as usize].push(edge_idx);
            incoming[to as usize].push(edge_idx);
        }
        graph_from_parts("divergent", nodes, edges, outgoing, incoming)
    }

    fn same_shape_divergent_delay_graph() -> Graph {
        let mut nodes = vec![
            port_node(0, "depth_in", PortDirection::Input),
            port_node(1, "delay_in", PortDirection::Input),
            combinational_node(2, "$and", None),
            combinational_node(3, "$and", None),
            combinational_node(4, "$and", None),
            combinational_node(5, "$and", None),
            combinational_node(6, "$and", None),
            port_node(7, "out", PortDirection::Output),
        ];
        for index in 0..8 {
            nodes.push(port_node(
                (8 + index) as NodeId,
                &format!("fanout_{index}"),
                PortDirection::Output,
            ));
        }
        for node in &mut nodes {
            if node.kind == NodeKind::PortBit {
                node.port_bit = Some(0);
            }
        }
        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); nodes.len()];
        let mut incoming = vec![Vec::new(); nodes.len()];
        for (from, to) in [(0, 2), (2, 3), (3, 6), (1, 4), (4, 5), (5, 6), (6, 7)] {
            let bit = edges.len() as u32;
            add_test_edge(&mut edges, &mut outgoing, &mut incoming, from, to, bit);
        }
        for to in 8..16 {
            let bit = edges.len() as u32;
            add_test_edge(&mut edges, &mut outgoing, &mut incoming, 4, to, bit);
        }
        graph_from_parts("same_shape_divergent", nodes, edges, outgoing, incoming)
    }

    fn port_node(id: NodeId, name: &str, direction: PortDirection) -> Node {
        Node {
            id,
            kind: NodeKind::PortBit,
            name: name.to_owned(),
            raw_name: name.to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: Some(name.to_owned()),
            port_bit: None,
            port_dir: Some(direction),
            const_value: None,
        }
    }

    fn register_bank_graph(groups: usize, width: usize) -> Graph {
        let mut nodes = Vec::with_capacity(groups + 1);
        nodes.push(Node {
            id: 0,
            kind: NodeKind::PortBit,
            name: "in".to_owned(),
            raw_name: "in".to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: Some("in".to_owned()),
            port_bit: Some(0),
            port_dir: Some(PortDirection::Input),
            const_value: None,
        });

        let mut edges = Vec::with_capacity(groups * width);
        let mut outgoing = vec![Vec::new(); groups + 1];
        let mut incoming = vec![Vec::new(); groups + 1];
        let mut net_aliases = HashMap::new();
        let mut cell_info = HashMap::new();
        let d_bits: Vec<YosysBit> = (0..width)
            .map(|bit| YosysBit::Net((bit + 1) as u32))
            .collect();

        for group in 0..groups {
            let id = (group + 1) as NodeId;
            nodes.push(Node {
                id,
                kind: NodeKind::Cell,
                name: format!("q{group}"),
                raw_name: format!("q{group}"),
                cell_type: Some("$dff".to_owned()),
                seq: true,
                blackbox: false,
                src: None,
                params: BTreeMap::new(),
                port: None,
                port_bit: None,
                port_dir: None,
                const_value: None,
            });

            let q_bits: Vec<YosysBit> = (0..width)
                .map(|bit| {
                    let net = 1_000_000 + group * width + bit;
                    net_aliases.insert(net as u32, vec![format!("q{group}[{bit}]")]);
                    YosysBit::Net(net as u32)
                })
                .collect();
            for bit in 0..width {
                let edge_idx = edges.len();
                edges.push(Edge {
                    from: 0,
                    to: id,
                    from_port: "in".to_owned(),
                    to_port: "D".to_owned(),
                    to_port_bit: bit as u32,
                    bit: Some((bit + 1) as u32),
                    net_name: format!("d[{bit}]"),
                    control: false,
                });
                outgoing[0].push(edge_idx);
                incoming[id as usize].push(edge_idx);
            }
            cell_info.insert(
                id,
                CellInfo {
                    q_bits,
                    d_bits: d_bits.clone(),
                    clock_net: None,
                    output_ports: HashSet::from(["Q".to_owned()]),
                    input_ports: HashSet::from(["D".to_owned()]),
                },
            );
        }

        Graph {
            nodes,
            edges,
            outgoing,
            incoming,
            top: "register_bank".to_owned(),
            net_names: HashMap::new(),
            net_aliases,
            cell_info,
            blackboxes: Vec::new(),
            signal_fanout: HashMap::new(),
            clock_network: Vec::new(),
        }
    }

    fn dense_dag_graph(node_count: usize) -> Graph {
        let nodes = (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", None))
            .collect();
        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); node_count];
        let mut incoming = vec![Vec::new(); node_count];
        let mut from = 0;
        while from < node_count {
            let mut to = from + 1;
            while to < node_count {
                let edge_idx = edges.len();
                edges.push(Edge {
                    from: from as NodeId,
                    to: to as NodeId,
                    from_port: "Y".to_owned(),
                    to_port: "A".to_owned(),
                    to_port_bit: 0,
                    bit: Some(edge_idx as u32),
                    net_name: format!("n{from}_{to}"),
                    control: false,
                });
                outgoing[from].push(edge_idx);
                incoming[to].push(edge_idx);
                to += 1;
            }
            from += 1;
        }
        graph_from_parts("dense", nodes, edges, outgoing, incoming)
    }

    fn branching_infrastructure_subgraph(
        hidden_count: usize,
        sink_count: usize,
    ) -> (Graph, Subgraph) {
        let node_count = 1 + hidden_count + sink_count;
        let mut nodes = Vec::with_capacity(node_count);
        nodes.push(combinational_node(0, "$and", None));
        for id in 1..=hidden_count {
            nodes.push(combinational_node(id as NodeId, "OBUF", None));
        }
        for id in (hidden_count + 1)..node_count {
            nodes.push(combinational_node(id as NodeId, "$and", None));
        }
        let graph = graph_from_parts(
            "projection",
            nodes,
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        );
        let projected_nodes = graph
            .nodes
            .iter()
            .map(|node| GraphNode {
                node: node_ref(&graph, node.id),
                is_root: None,
                is_boundary: None,
                depth: None,
                params: BTreeMap::new(),
                controls: Vec::new(),
                width: None,
                member_count: None,
                members: None,
            })
            .collect();
        let mut edges = Vec::new();
        for hidden in 1..=hidden_count {
            edges.push(GraphEdge {
                from: 0,
                to: hidden as NodeId,
                from_port: "Y".to_owned(),
                to_port: "I".to_owned(),
                net_name: format!("to_hidden_{hidden}"),
                bits: vec![hidden as u32],
                control: None,
            });
            for sink in 0..sink_count {
                let sink_id = (hidden_count + 1 + sink) as NodeId;
                edges.push(GraphEdge {
                    from: hidden as NodeId,
                    to: sink_id,
                    from_port: "O".to_owned(),
                    to_port: "A".to_owned(),
                    net_name: format!("h{hidden}_s{sink}"),
                    bits: vec![(hidden * sink_count + sink) as u32],
                    control: None,
                });
            }
        }
        (
            graph,
            Subgraph {
                nodes: projected_nodes,
                edges,
                truncated: false,
            },
        )
    }

    fn wide_branching_infrastructure_subgraph(width: usize, branches: usize) -> (Graph, Subgraph) {
        let sink_id = (branches + 2) as NodeId;
        let mut nodes = Vec::with_capacity(branches + 3);
        nodes.push(combinational_node(0, "$and", None));
        nodes.push(combinational_node(1, "OBUF", None));
        for id in 0..branches {
            nodes.push(combinational_node((id + 2) as NodeId, "OBUF", None));
        }
        nodes.push(combinational_node(sink_id, "$and", None));
        let graph = graph_from_parts(
            "wide_projection",
            nodes,
            Vec::new(),
            vec![Vec::new(); branches + 3],
            vec![Vec::new(); branches + 3],
        );
        let projected_nodes = graph
            .nodes
            .iter()
            .map(|node| GraphNode {
                node: node_ref(&graph, node.id),
                is_root: None,
                is_boundary: None,
                depth: None,
                params: BTreeMap::new(),
                controls: Vec::new(),
                width: None,
                member_count: None,
                members: None,
            })
            .collect();
        let mut edges = Vec::with_capacity(1 + 2 * branches);
        edges.push(GraphEdge {
            from: 0,
            to: 1,
            from_port: "Y".to_owned(),
            to_port: "I".to_owned(),
            net_name: "wide".to_owned(),
            bits: (0..width as u32).collect(),
            control: None,
        });
        for branch in 0..branches {
            let branch_id = (branch + 2) as NodeId;
            edges.push(GraphEdge {
                from: 1,
                to: branch_id,
                from_port: "O".to_owned(),
                to_port: "I".to_owned(),
                net_name: format!("branch_{branch}"),
                bits: Vec::new(),
                control: None,
            });
            edges.push(GraphEdge {
                from: branch_id,
                to: sink_id,
                from_port: "O".to_owned(),
                to_port: "A".to_owned(),
                net_name: format!("sink_{branch}"),
                bits: vec![branch as u32],
                control: None,
            });
        }
        (
            graph,
            Subgraph {
                nodes: projected_nodes,
                edges,
                truncated: false,
            },
        )
    }

    fn deep_register_bank_graph(groups: usize, depth: usize) -> Graph {
        let node_count = 1 + depth + groups;
        let mut nodes = Vec::with_capacity(node_count);
        nodes.push(Node {
            id: 0,
            kind: NodeKind::PortBit,
            name: "in".to_owned(),
            raw_name: "in".to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: Some("in".to_owned()),
            port_bit: Some(0),
            port_dir: Some(PortDirection::Input),
            const_value: None,
        });
        for id in 1..=depth {
            nodes.push(combinational_node(id as NodeId, "$and", None));
        }
        for group in 0..groups {
            let id = (depth + 1 + group) as NodeId;
            nodes.push(Node {
                id,
                kind: NodeKind::Cell,
                name: format!("q{group}"),
                raw_name: format!("q{group}"),
                cell_type: Some("$dff".to_owned()),
                seq: true,
                blackbox: false,
                src: None,
                params: BTreeMap::new(),
                port: None,
                port_bit: None,
                port_dir: None,
                const_value: None,
            });
        }

        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); node_count];
        let mut incoming = vec![Vec::new(); node_count];
        for step in 0..depth {
            add_test_edge(
                &mut edges,
                &mut outgoing,
                &mut incoming,
                step as NodeId,
                (step + 1) as NodeId,
                step as u32,
            );
        }
        let mut net_aliases = HashMap::new();
        let mut cell_info = HashMap::new();
        for group in 0..groups {
            let id = (depth + 1 + group) as NodeId;
            let data_net = depth.saturating_sub(1) as u32;
            add_test_edge(
                &mut edges,
                &mut outgoing,
                &mut incoming,
                depth as NodeId,
                id,
                data_net,
            );
            let q_net = 1_000_000 + group as u32;
            net_aliases.insert(q_net, vec![format!("q{group}[0]")]);
            cell_info.insert(
                id,
                CellInfo {
                    q_bits: vec![YosysBit::Net(q_net)],
                    d_bits: vec![YosysBit::Net(data_net)],
                    clock_net: None,
                    output_ports: HashSet::from(["Q".to_owned()]),
                    input_ports: HashSet::from(["D".to_owned()]),
                },
            );
        }
        let mut graph = graph_from_parts("deep_bank", nodes, edges, outgoing, incoming);
        graph.net_aliases = net_aliases;
        graph.cell_info = cell_info;
        graph
    }

    fn sourced_node_graph(node_count: usize) -> Graph {
        let nodes = (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", Some("source.sv:1")))
            .collect();
        graph_from_parts(
            "sourced",
            nodes,
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        )
    }

    fn selection_options() -> SourceSelectionOptions {
        SourceSelectionOptions {
            max_nodes: 400,
            hide_control: true,
            hide_const: true,
            group_vectors: false,
            group_memories: false,
        }
    }

    fn empty_source_index(file: &str) -> SourceLineIndex {
        let module = YosysModule {
            attributes: BTreeMap::new(),
            ports: BTreeMap::new(),
            cells: BTreeMap::new(),
            memories: BTreeMap::new(),
            netnames: BTreeMap::new(),
        };
        SourceLineIndex::from_module(&module, vec![file.to_owned()])
    }

    fn source_selection_fixture() -> Graph {
        let nodes = vec![
            port_node(0, "a", PortDirection::Input),
            combinational_node(1, "$and", None),
            port_node(2, "y", PortDirection::Output),
        ];
        let edges = vec![
            Edge {
                from: 0,
                to: 1,
                from_port: "a".to_owned(),
                to_port: "A".to_owned(),
                to_port_bit: 0,
                bit: Some(0),
                net_name: "a".to_owned(),
                control: false,
            },
            Edge {
                from: 1,
                to: 2,
                from_port: "Y".to_owned(),
                to_port: "y".to_owned(),
                to_port_bit: 0,
                bit: Some(1),
                net_name: "y".to_owned(),
                control: false,
            },
        ];
        graph_from_parts(
            "source_selection",
            nodes,
            edges,
            vec![vec![0], vec![1], Vec::new()],
            vec![Vec::new(), vec![0], vec![1]],
        )
    }

    fn combinational_node(id: NodeId, cell_type: &str, src: Option<&str>) -> Node {
        Node {
            id,
            kind: NodeKind::Cell,
            name: format!("n{id}"),
            raw_name: format!("n{id}"),
            cell_type: Some(cell_type.to_owned()),
            seq: false,
            blackbox: false,
            src: src.map(str::to_owned),
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: None,
        }
    }

    fn constant_node(id: NodeId, value: &str) -> Node {
        Node {
            id,
            kind: NodeKind::Const,
            name: value.to_owned(),
            raw_name: value.to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: Some(value.to_owned()),
        }
    }

    fn add_test_edge(
        edges: &mut Vec<Edge>,
        outgoing: &mut [Vec<usize>],
        incoming: &mut [Vec<usize>],
        from: NodeId,
        to: NodeId,
        bit: u32,
    ) {
        let edge_idx = edges.len();
        edges.push(Edge {
            from,
            to,
            from_port: "Y".to_owned(),
            to_port: if to as usize + 1 == outgoing.len() {
                "D".to_owned()
            } else {
                "A".to_owned()
            },
            to_port_bit: 0,
            bit: Some(bit),
            net_name: format!("n{bit}"),
            control: false,
        });
        outgoing[from as usize].push(edge_idx);
        incoming[to as usize].push(edge_idx);
    }

    fn graph_from_parts(
        top: &str,
        nodes: Vec<Node>,
        edges: Vec<Edge>,
        outgoing: Vec<Vec<usize>>,
        incoming: Vec<Vec<usize>>,
    ) -> Graph {
        Graph {
            nodes,
            edges,
            outgoing,
            incoming,
            top: top.to_owned(),
            net_names: HashMap::new(),
            net_aliases: HashMap::new(),
            cell_info: HashMap::new(),
            blackboxes: Vec::new(),
            signal_fanout: HashMap::new(),
            clock_network: Vec::new(),
        }
    }

    fn edge_signature(subgraph: &Subgraph) -> Vec<EdgeSignature> {
        subgraph
            .edges
            .iter()
            .map(|edge| {
                (
                    edge.from,
                    edge.to,
                    edge.from_port.clone(),
                    edge.to_port.clone(),
                    edge.net_name.clone(),
                    edge.bits.clone(),
                    edge.control,
                )
            })
            .collect()
    }
}
