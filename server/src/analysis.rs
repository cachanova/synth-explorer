use crate::delay_model::DelayModel;
use crate::graph::{
    Edge, Graph, NodeId, NodeKind, cell_depth_weight, is_addressable_sequential_type,
    is_infrastructure_cell, is_register_type, is_transparent_data_buffer, strip_bit_suffix,
};
use crate::grouping::{GroupId, GroupKind, GroupPartition};
use crate::netlist::{PortDirection, YosysModule, YosysNetlist};
use serde::Serialize;
use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::mem::size_of;

const PATH_NODE_CAP: usize = 512;
const PATH_RECONSTRUCTION_NODE_BUDGET: usize = 65_536;
pub const MAX_SUBGRAPH_NODES: usize = 2_000;
pub const MAX_SUBGRAPH_EDGES: usize = 10_000;
pub(crate) const SOURCE_ROOT_COLLECTION_CAP: usize = MAX_SUBGRAPH_NODES + 1;
const SOURCE_LINE_RESPONSE_CAP: usize = 10_000;
const SOURCE_LINE_RESPONSE_NODE_BUDGET: usize = 20_000;
const SOURCE_RANGE_RESPONSE_CAP: usize = 10_000;
pub(crate) const SOURCE_RANGE_ASSOCIATION_CAP: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiNodeKind {
    Cell,
    Port,
    Const,
}

#[derive(Debug, Clone, Serialize)]
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
    /// Number of member bits collapsed into this node; present only on grouped
    /// vector nodes (`group_vectors=true`). Equals the members carried here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Real graph node ids collapsed into this group; present only on grouped
    /// vector nodes. These are the per-bit ids `/nodes` still addresses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct EndpointBit {
    pub bit: usize,
    pub node_id: u32,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct InputBit {
    pub bit: usize,
    pub node_id: u32,
}

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct OutputAliasBit {
    pub output_bit: usize,
    pub register_bit: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputAlias {
    pub name: String,
    pub width: usize,
    pub bits: Vec<OutputAliasBit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputGroup {
    pub name: String,
    pub width: usize,
    pub worst_depth: u32,
    pub bits: Vec<EndpointBit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InputGroup {
    pub name: String,
    pub width: usize,
    pub bits: Vec<InputBit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EndpointsResponse {
    pub registers: Vec<RegisterGroup>,
    pub outputs: Vec<OutputGroup>,
    pub inputs: Vec<InputGroup>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKind {
    Register,
    Output,
    Blackbox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct SourceMapResponse {
    pub files: Vec<String>,
    pub by_line: BTreeMap<String, Vec<u32>>,
    pub ranges: Vec<SourceRangeMapping>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct SourceRangeMapping {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub node_ids: Vec<u32>,
    pub mapping_incomplete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum SourceProbeDirection {
    Fanin,
    Fanout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum SourceProbeHintKind {
    Block,
    OutputPort,
    Procedural,
    Signal,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct SourceProbeHint {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    pub direction: SourceProbeDirection,
    pub kind: SourceProbeHintKind,
}

pub(crate) struct SourceProbeSelection {
    pub roots: Vec<NodeId>,
    /// `None` retains the legacy bidirectional envelope for unclassified or
    /// mixed-direction source ranges.
    pub direction: Option<ConeDir>,
    pub highlight_logic: bool,
    pub expand_output_register_inputs: bool,
}

#[derive(Debug, Clone, Default)]
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

#[derive(Debug, Clone)]
pub struct SourceLineIndex {
    files: HashSet<String>,
    lines: HashSet<String>,
    recovered_ranges: BTreeMap<String, IntervalIndex>,
}

impl SourceLineIndex {
    /// Deterministic retained-allocation estimate, not allocator-exact RSS.
    pub fn estimated_heap_bytes(&self) -> usize {
        let mut bytes = self.files.capacity().saturating_mul(size_of::<String>());
        for file in &self.files {
            bytes = bytes.saturating_add(file.capacity());
        }
        bytes = bytes.saturating_add(self.lines.capacity().saturating_mul(size_of::<String>()));
        for line in &self.lines {
            bytes = bytes.saturating_add(line.capacity());
        }
        bytes = bytes.saturating_add(
            self.recovered_ranges
                .len()
                .saturating_mul(size_of::<(String, IntervalIndex)>() + 3 * size_of::<usize>()),
        );
        for (file, index) in &self.recovered_ranges {
            bytes = bytes
                .saturating_add(file.capacity())
                .saturating_add(
                    index
                        .intervals
                        .capacity()
                        .saturating_mul(size_of::<(usize, usize)>()),
                )
                .saturating_add(
                    index
                        .prefix_max_end
                        .capacity()
                        .saturating_mul(size_of::<usize>()),
                );
        }
        bytes
    }

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
        for module in modules {
            for cell in module.cells.values() {
                let Some(src) = cell.attributes.get("src") else {
                    continue;
                };
                insert_src_lines(src, |file, line| {
                    lines.insert(format!("{file}:{line}"));
                });
            }
        }
        Self {
            files: files.into_iter().collect(),
            lines,
            recovered_ranges: BTreeMap::new(),
        }
    }

    pub fn contains_range(&self, file: &str, start_line: usize, end_line: usize) -> Option<bool> {
        if !self.files.contains(file) {
            return None;
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
        for range in ranges {
            self.recovered_ranges
                .entry(range.file.clone())
                .or_default()
                .intervals
                .push((range.start_line, range.end_line));
        }
        for index in self.recovered_ranges.values_mut() {
            index.rebuild();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
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
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DepthSummary {
    pub input_to_register: Option<u32>,
    pub register_to_register: Option<u32>,
    pub register_to_output: Option<u32>,
    pub input_to_output: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CellCategoryCounts {
    pub logic: usize,
    pub registers: usize,
    pub carry_special: usize,
    pub infrastructure: usize,
}

struct DepthComputation {
    node_depth: Vec<Option<u32>>,
    best_pred: Vec<Option<usize>>,
    node_startpoint: Vec<Option<NodeId>>,
    /// Estimated worst-case combinational delay (picoseconds) over all paths —
    /// a rough pre-place-and-route figure from the fanout-aware delay model.
    estimated_max_delay_ps: Option<f64>,
    /// Per-node arrival time (picoseconds) at each comb node's output, for
    /// reconstructing a specific path's estimated delay.
    node_delay: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct Analysis {
    pub node_depth: Vec<Option<u32>>,
    node_delay: Vec<f64>,
    pub best_pred: Vec<Option<usize>>,
    pub comb_loops: Vec<NodeId>,
    pub endpoints: EndpointsResponse,
    endpoint_targets: Vec<EndpointTarget>,
    source_map: SourceMapResponse,
    source_ranges: BTreeMap<String, SourceRangeIndex>,
    source_probe_hints: BTreeMap<String, SourceProbeHintIndex>,
    synthetic_src: HashMap<NodeId, BTreeSet<String>>,
    procedural_targets: BTreeMap<String, BTreeMap<usize, Vec<NodeId>>>,
    stats: Stats,
    warnings: Vec<String>,
    /// The delay model used for the estimated timing figures (from the target).
    delay_model: DelayModel,
}

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone, Default)]
struct SourceRangeIndex {
    ranges: Vec<SourceRangeMapping>,
    prefix_max_end: Vec<usize>,
}

#[derive(Debug, Clone, Default)]
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

type PathGroupKey = (String, EndpointKind, PathClass, u32, String, Vec<String>);

impl Analysis {
    /// Deterministic estimate of heap allocation retained by analysis indexes.
    /// Collection capacities and owned buffers are counted without cloning.
    pub fn estimated_heap_bytes(&self) -> usize {
        let mut bytes = self
            .node_depth
            .capacity()
            .saturating_mul(size_of::<Option<u32>>())
            .saturating_add(
                self.best_pred
                    .capacity()
                    .saturating_mul(size_of::<Option<usize>>()),
            )
            .saturating_add(
                self.comb_loops
                    .capacity()
                    .saturating_mul(size_of::<NodeId>()),
            )
            .saturating_add(endpoints_heap_bytes(&self.endpoints))
            .saturating_add(
                self.endpoint_targets
                    .capacity()
                    .saturating_mul(size_of::<EndpointTarget>()),
            );
        for target in &self.endpoint_targets {
            bytes = bytes
                .saturating_add(target.endpoint_port.capacity())
                .saturating_add(target.group.capacity());
        }
        bytes = bytes.saturating_add(source_map_heap_bytes(&self.source_map));
        bytes = bytes.saturating_add(
            self.source_ranges
                .len()
                .saturating_mul(size_of::<(String, SourceRangeIndex)>() + 3 * size_of::<usize>()),
        );
        for (file, index) in &self.source_ranges {
            bytes = bytes
                .saturating_add(file.capacity())
                .saturating_add(
                    index
                        .ranges
                        .capacity()
                        .saturating_mul(size_of::<SourceRangeMapping>()),
                )
                .saturating_add(
                    index
                        .prefix_max_end
                        .capacity()
                        .saturating_mul(size_of::<usize>()),
                );
            for range in &index.ranges {
                bytes = bytes.saturating_add(source_range_heap_bytes(range));
            }
        }
        bytes =
            bytes.saturating_add(self.source_probe_hints.len().saturating_mul(
                size_of::<(String, SourceProbeHintIndex)>() + 3 * size_of::<usize>(),
            ));
        for (file, index) in &self.source_probe_hints {
            bytes = bytes
                .saturating_add(file.capacity())
                .saturating_add(
                    index
                        .hints
                        .capacity()
                        .saturating_mul(size_of::<SourceProbeHint>()),
                )
                .saturating_add(
                    index
                        .prefix_max_end
                        .capacity()
                        .saturating_mul(size_of::<usize>()),
                );
            for hint in &index.hints {
                bytes = bytes.saturating_add(hint.file.capacity());
            }
        }
        bytes = bytes.saturating_add(
            self.synthetic_src
                .capacity()
                .saturating_mul(size_of::<(NodeId, BTreeSet<String>)>()),
        );
        for sources in self.synthetic_src.values() {
            bytes = bytes.saturating_add(
                sources
                    .len()
                    .saturating_mul(size_of::<String>() + 3 * size_of::<usize>()),
            );
            for source in sources {
                bytes = bytes.saturating_add(source.capacity());
            }
        }
        bytes = bytes.saturating_add(self.procedural_targets.len().saturating_mul(
            size_of::<(String, BTreeMap<usize, Vec<NodeId>>)>() + 3 * size_of::<usize>(),
        ));
        for (file, targets) in &self.procedural_targets {
            bytes = bytes.saturating_add(file.capacity()).saturating_add(
                targets
                    .len()
                    .saturating_mul(size_of::<(usize, Vec<NodeId>)>() + 3 * size_of::<usize>()),
            );
            for ids in targets.values() {
                bytes = bytes.saturating_add(ids.capacity().saturating_mul(size_of::<NodeId>()));
            }
        }
        bytes = bytes.saturating_add(stats_heap_bytes(&self.stats));
        bytes = bytes.saturating_add(self.warnings.capacity().saturating_mul(size_of::<String>()));
        for warning in &self.warnings {
            bytes = bytes.saturating_add(warning.capacity());
        }
        bytes
    }

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
            node_startpoint,
            estimated_max_delay_ps,
            node_delay,
        } = compute_depths(graph, &loop_set, model);
        let (endpoints, endpoint_targets) =
            discover_endpoints(graph, &node_depth, &node_startpoint, &source_files);
        let source_map = build_source_map(graph, source_files);
        let stats = build_stats(graph, &endpoints, &endpoint_targets, estimated_max_delay_ps);
        let warnings = build_warnings(graph, &comb_loops);
        Self {
            node_depth,
            node_delay,
            best_pred,
            comb_loops,
            endpoints,
            endpoint_targets,
            source_map,
            source_ranges: BTreeMap::new(),
            source_probe_hints: BTreeMap::new(),
            synthetic_src: HashMap::new(),
            procedural_targets: BTreeMap::new(),
            stats,
            warnings,
            delay_model: *model,
        }
    }

    /// Install per-line procedural assignment targets recovered from the
    /// submitted sources so `source_nodes_range` can narrow block-attributed
    /// probes to the assigned signals.
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

    pub fn endpoints(&self) -> EndpointsResponse {
        self.endpoints.clone()
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

    pub fn source_mapping_incomplete(
        &self,
        file: &str,
        start_line: usize,
        end_line: usize,
    ) -> Option<bool> {
        if !self.source_map.files.iter().any(|name| name == file) {
            return None;
        }
        Some(self.source_ranges.get(file).is_some_and(|index| {
            index
                .overlapping(start_line, end_line)
                .iter()
                .any(|range| range.end_line >= start_line && range.mapping_incomplete)
        }))
    }

    pub fn extend_source_ranges(&mut self, ranges: Vec<SourceRangeMapping>, truncated: bool) {
        for range in ranges {
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
        self.source_map.truncated |= truncated;
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

    pub fn source_nodes_range(
        &self,
        graph: &Graph,
        file: &str,
        start_line: usize,
        end_line: usize,
    ) -> Option<Vec<NodeId>> {
        if !self.source_map.files.iter().any(|name| name == file) {
            return None;
        }
        let mut ids = BTreeSet::new();
        'collect: {
            for line in start_line..=end_line {
                if let Some(line_ids) = self.source_map.by_line.get(&format!("{file}:{line}")) {
                    for id in line_ids {
                        if insert_bounded_node(&mut ids, *id) {
                            break 'collect;
                        }
                    }
                }
            }
            if let Some(index) = self.source_ranges.get(file) {
                for range in index.overlapping(start_line, end_line) {
                    if range.end_line < start_line {
                        continue;
                    }
                    for id in &range.node_ids {
                        if insert_bounded_node(&mut ids, *id) {
                            break 'collect;
                        }
                    }
                }
            }
        }
        let roots: Vec<NodeId> = ids.into_iter().collect();
        Some(self.narrow_to_assignment_targets(graph, file, start_line, end_line, roots))
    }

    pub(crate) fn source_probe_range(
        &self,
        graph: &Graph,
        file: &str,
        start_line: usize,
        end_line: usize,
    ) -> Option<SourceProbeSelection> {
        let default_roots = self.source_nodes_range(graph, file, start_line, end_line)?;
        let Some(index) = self.source_probe_hints.get(file) else {
            return Some(SourceProbeSelection {
                roots: default_roots,
                direction: None,
                highlight_logic: false,
                expand_output_register_inputs: false,
            });
        };
        let overlapping: Vec<&SourceProbeHint> = index
            .overlapping(start_line, end_line)
            .iter()
            .filter(|hint| hint.end_line >= start_line)
            .collect();
        if overlapping.is_empty() {
            return Some(SourceProbeSelection {
                roots: default_roots,
                direction: None,
                highlight_logic: false,
                expand_output_register_inputs: false,
            });
        }

        // A direct assignment/declaration on one selected line is more
        // specific than the always-block interval that also covers it. Wider
        // selections retain every overlapping hint so selecting a whole block
        // still returns all of its driven signals.
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
        for hint in &selected {
            if hint.kind != SourceProbeHintKind::Procedural {
                continue;
            }
            if let Some(targets) = self.procedural_targets.get(file) {
                for ids in targets
                    .range(hint.start_line..=hint.end_line)
                    .map(|(_, ids)| ids)
                {
                    for id in ids {
                        if insert_bounded_node(&mut roots, *id) {
                            break;
                        }
                    }
                }
            }
        }
        for hint in &selected {
            if hint.kind != SourceProbeHintKind::Block {
                continue;
            }
            if let Some(targets) = self.procedural_targets.get(file) {
                for ids in targets
                    .range(hint.start_line..=hint.end_line)
                    .map(|(_, ids)| ids)
                {
                    for id in ids {
                        if insert_bounded_node(&mut roots, *id) {
                            break;
                        }
                    }
                }
            }
        }
        if roots.is_empty() {
            roots.extend(self.source_nodes_range(graph, file, start_line, end_line)?);
        }

        let mut directions = selected.iter().map(|hint| hint.direction);
        let first = directions.next();
        let uniform = first.filter(|direction| directions.all(|other| other == *direction));
        Some(SourceProbeSelection {
            roots: roots.into_iter().collect(),
            direction: uniform.map(|direction| match direction {
                SourceProbeDirection::Fanin => ConeDir::Fanin,
                SourceProbeDirection::Fanout => ConeDir::Fanout,
            }),
            highlight_logic: true,
            expand_output_register_inputs: selected
                .iter()
                .any(|hint| hint.kind == SourceProbeHintKind::OutputPort),
        })
    }

    /// Yosys attributes procedural cells to whole `always` blocks, so a
    /// single-line probe inside a block would otherwise root every register in
    /// it. When every selected line that contributed a block-attributed root
    /// (a root with a covering src span extending outside the selection) has
    /// parsed assignment targets, keep only targeted roots plus roots whose
    /// covering spans lie fully inside the selection. Any parsing or
    /// resolution gap falls back to the unfiltered attribution.
    fn narrow_to_assignment_targets(
        &self,
        graph: &Graph,
        file: &str,
        start_line: usize,
        end_line: usize,
        roots: Vec<NodeId>,
    ) -> Vec<NodeId> {
        if roots.is_empty() || self.procedural_targets.is_empty() {
            return roots;
        }
        let block_roots: HashSet<NodeId> = roots
            .iter()
            .copied()
            .filter(|id| self.is_block_attributed(graph, *id, file, start_line, end_line))
            .collect();
        if block_roots.is_empty() {
            return roots;
        }
        let overlapping = self
            .source_ranges
            .get(file)
            .map_or(&[][..], |index| index.overlapping(start_line, end_line));
        let mut targets: HashSet<NodeId> = HashSet::new();
        for line in start_line..=end_line {
            let line_targets = self
                .procedural_targets
                .get(file)
                .and_then(|targets| targets.get(&line));
            if let Some(ids) = line_targets {
                targets.extend(ids.iter().copied());
            }
            let contributed_block_root = self
                .source_map
                .by_line
                .get(&format!("{file}:{line}"))
                .is_some_and(|ids| ids.iter().any(|id| block_roots.contains(id)))
                || overlapping.iter().any(|range| {
                    range.start_line <= line
                        && line <= range.end_line
                        && range.node_ids.iter().any(|id| block_roots.contains(id))
                });
            if contributed_block_root && line_targets.is_none_or(|ids| ids.is_empty()) {
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

    /// A root is block-attributed for a selection when any of its covering src
    /// spans in `file` overlaps the selection but extends outside it.
    fn is_block_attributed(
        &self,
        graph: &Graph,
        id: NodeId,
        file: &str,
        start_line: usize,
        end_line: usize,
    ) -> bool {
        let spans_outside = |src: &str| {
            src.split('|').any(|loc| {
                parse_src_loc(loc).is_some_and(|(span_file, span_start, span_end)| {
                    span_file == file
                        && span_start <= end_line
                        && span_end >= start_line
                        && (span_start < start_line || span_end > end_line)
                })
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

    /// Longest structural paths, delay-costed with the design's synth-time model.
    pub fn paths(&self, graph: &Graph, limit: usize, to: Option<NodeId>) -> PathsResponse {
        self.paths_with_model(graph, &self.delay_model, limit, to)
    }

    /// Like [`Analysis::paths`], but delay-costs each path with a caller-supplied
    /// model (e.g. a client's retune), so per-path delays track the overview.
    pub fn paths_with_model(
        &self,
        graph: &Graph,
        model: &DelayModel,
        limit: usize,
        to: Option<NodeId>,
    ) -> PathsResponse {
        // Path structure (targets, routes) is model-independent; only the delay
        // numbers depend on the model. Reuse the synth-time arrivals when the
        // caller's model matches, else recompute the delay DP for it.
        let recomputed;
        let node_delay: &[f64] = if *model == self.delay_model {
            &self.node_delay
        } else {
            let loop_set: HashSet<NodeId> = find_comb_loops(graph).into_iter().collect();
            recomputed = compute_depths(graph, &loop_set, model).node_delay;
            &recomputed
        };
        const TARGETS_PER_GROUP_CAP: usize = 64;
        let candidate_cap = limit.max(1).saturating_mul(16).min(8000);
        let mut total_targets = 0;
        let mut grouped_targets: HashMap<(EndpointKind, &str), Vec<&EndpointTarget>> =
            HashMap::new();
        for target in self
            .endpoint_targets
            .iter()
            .filter(|target| to.is_none_or(|id| target.endpoint == id))
        {
            total_targets += 1;
            let group = grouped_targets
                .entry((target.kind, target.group.as_str()))
                .or_default();
            if group.len() < TARGETS_PER_GROUP_CAP {
                group.push(target);
                continue;
            }
            let worst = group
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| compare_target_rank(a, b))
                .map(|(index, _)| index)
                .expect("a capped target group is not empty");
            if compare_target_rank(target, group[worst]) == Ordering::Less {
                group[worst] = target;
            }
        }

        let mut target_groups: Vec<((EndpointKind, &str), Vec<&EndpointTarget>)> =
            grouped_targets.into_iter().collect();
        for (_, targets) in &mut target_groups {
            targets.sort_by(|a, b| compare_target_rank(a, b));
        }
        target_groups.sort_by(|(a_key, a), (b_key, b)| {
            Reverse(a[0].depth)
                .cmp(&Reverse(b[0].depth))
                .then_with(|| a_key.cmp(b_key))
        });

        // Give every deepest logical endpoint a representative before spending
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
        let mut reconstruction_budget = PATH_RECONSTRUCTION_NODE_BUDGET;
        let mut reconstructed_candidates = 0;
        for target in &candidates {
            if reconstruction_budget < 2 {
                route_clipped = true;
                break;
            }
            let per_path_cap = PATH_NODE_CAP.min(reconstruction_budget);
            let (path, clipped, consumed_nodes) = self.path_for_target(
                graph,
                target,
                per_path_cap,
                &alias_lookup,
                node_delay,
                model,
            );
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
        paths.sort_by_key(|path| {
            (
                Reverse(path.depth),
                path.endpoint_group.clone(),
                path.bits.first().copied().unwrap_or_default(),
            )
        });
        let grouped_count = paths.len();
        paths.truncate(limit);
        PathsResponse {
            paths,
            comb_loops: self
                .comb_loops
                .iter()
                .map(|id| graph.node_ref_name(*id))
                .collect(),
            truncated: route_clipped
                || reconstructed_candidates < candidates.len()
                || candidates.len() < total_targets
                || grouped_count > limit,
        }
    }

    pub fn cone(
        &self,
        graph: &Graph,
        root: NodeId,
        options: ConeOptions,
        grouping: Option<&GroupPartition>,
    ) -> Option<Subgraph> {
        self.multi_root_cone(graph, &[root], options, grouping)
    }

    pub fn multi_root_cone(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
        grouping: Option<&GroupPartition>,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(graph, roots, &[options.dir], options, grouping, false)
    }

    pub(crate) fn multi_root_source_cone(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
        grouping: Option<&GroupPartition>,
        expand_output_register_inputs: bool,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[options.dir],
            options,
            grouping,
            expand_output_register_inputs,
        )
    }

    pub fn envelope(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
        grouping: Option<&GroupPartition>,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[ConeDir::Fanin, ConeDir::Fanout],
            options,
            grouping,
            false,
        )
    }

    fn multi_root_subgraph(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        directions: &[ConeDir],
        options: ConeOptions,
        grouping: Option<&GroupPartition>,
        expand_output_register_inputs: bool,
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
        let mut seen: HashSet<NodeId> = HashSet::new();
        let mut seen_units: HashSet<u32> = HashSet::new();
        let mut unique_roots: HashSet<NodeId> = HashSet::new();
        let mut included_root_ids = Vec::new();
        let mut boundary_nodes: HashSet<NodeId> = HashSet::new();
        let mut edge_set: HashSet<usize> = HashSet::new();
        let mut expanded_register_inputs: HashSet<NodeId> = HashSet::new();
        let mut truncated = false;

        for root in roots {
            if unique_roots.insert(*root) {
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
        let mut output_register_frontier: HashSet<NodeId> = if expand_output_register_inputs {
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
                    .map(|root| (root, 0))
                    .collect(),
                current: None,
            })
            .collect();

        loop {
            let mut advanced = false;
            for traversal in &mut traversals {
                loop {
                    if traversal.current.is_none() {
                        let Some((id, depth)) = traversal.queue.pop_front() else {
                            break;
                        };
                        if !included_roots.contains(&id)
                            && graph.is_boundary(id)
                            && !expanded_register_inputs.contains(&id)
                            && !is_addressable_sequential_node(graph, id)
                        {
                            boundary_nodes.insert(id);
                            continue;
                        }
                        if depth >= options.max_depth {
                            if has_visible_neighbor(
                                graph,
                                id,
                                traversal.dir,
                                options.hide_control,
                                options.hide_const,
                            ) {
                                boundary_nodes.insert(id);
                                truncated = true;
                            }
                            continue;
                        }
                        traversal.current = Some(TraversalFrame {
                            id,
                            depth,
                            next_edge: 0,
                        });
                    }

                    let frame = traversal.current.as_mut().expect("frame was initialized");
                    let edge_ids = match traversal.dir {
                        ConeDir::Fanin => &graph.incoming[frame.id as usize],
                        ConeDir::Fanout => &graph.outgoing[frame.id as usize],
                    };
                    let Some(edge_idx) = edge_ids.get(frame.next_edge).copied() else {
                        traversal.current = None;
                        continue;
                    };
                    frame.next_edge += 1;
                    let edge = &graph.edges[edge_idx];
                    if should_hide_edge(graph, edge, options.hide_control, options.hide_const) {
                        continue;
                    }
                    if traversal.dir == ConeDir::Fanin
                        && is_addressable_sequential_node(graph, frame.id)
                        && !included_roots.contains(&frame.id)
                        && !is_depth_input_edge(graph, edge)
                    {
                        continue;
                    }
                    if traversal.dir == ConeDir::Fanout
                        && is_addressable_sequential_node(graph, frame.id)
                        && !included_roots.contains(&frame.id)
                        && !is_depth_output_edge(graph, edge)
                    {
                        continue;
                    }

                    advanced = true;
                    let next = match traversal.dir {
                        ConeDir::Fanin => edge.from,
                        ConeDir::Fanout => edge.to,
                    };
                    if !seen.contains(&next) {
                        let unit = unit_id(grouping, base, next);
                        if !seen_units.contains(&unit) && seen_units.len() >= cap {
                            truncated = true;
                            break;
                        }
                        seen_units.insert(unit);
                        seen.insert(next);
                    }
                    if expand_output_register_inputs
                        && traversal.dir == ConeDir::Fanin
                        && output_register_frontier.contains(&frame.id)
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
                        traversal.queue.push_back((next, frame.depth + 1));
                    }
                    edge_set.insert(edge_idx);
                    break;
                }
            }
            if !advanced {
                break;
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
        max_nodes: usize,
        show_infrastructure: bool,
        hide_control: bool,
        hide_const: bool,
        grouping: Option<&GroupPartition>,
    ) -> Subgraph {
        let base = graph.nodes.len() as u32;
        let cap = max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
        // Take the first `cap` group-or-singleton units in node order. A group's
        // members can be non-contiguous, so keep scanning to admit every member
        // of an already-counted unit rather than breaking at the cap.
        let mut seen = HashSet::new();
        let mut seen_units: HashSet<u32> = HashSet::new();
        let mut truncated = false;
        for node in &graph.nodes {
            if hide_const && node.kind == NodeKind::Const {
                continue;
            }
            let unit = unit_id(grouping, base, node.id);
            if seen_units.contains(&unit) {
                seen.insert(node.id);
            } else if seen_units.len() < cap {
                seen_units.insert(unit);
                seen.insert(node.id);
            } else {
                truncated = true;
            }
        }
        let edge_set: HashSet<usize> = graph
            .edges
            .iter()
            .enumerate()
            .filter(|(_, edge)| {
                seen.contains(&edge.from)
                    && seen.contains(&edge.to)
                    && (!hide_control || !is_labeled_control_edge(graph, edge))
            })
            .map(|(idx, _)| idx)
            .collect();
        let empty = HashSet::new();
        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                boundary_nodes: &empty,
                truncated,
                show_infrastructure,
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
        node_delay: &[f64],
        model: &DelayModel,
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
                let Some(pred_edge) = self.best_pred[current as usize] else {
                    break;
                };
                downstream_edge = pred_edge;
                current = graph.edges[pred_edge].from;
            }
        }
        let consumed_nodes = node_ids.len();
        if clipped && node_ids.last().copied() != Some(target.startpoint) {
            *node_ids
                .last_mut()
                .expect("an endpoint path always contains its endpoint") = target.startpoint;
        }
        node_ids.reverse();
        let nodes: Vec<NodeRef> = node_ids
            .iter()
            .filter(|id| {
                **id == target.startpoint
                    || **id == target.endpoint
                    || graph.nodes[**id as usize]
                        .cell_type
                        .as_deref()
                        .is_none_or(|cell_type| !is_infrastructure_cell(cell_type))
            })
            .map(|id| self.node_ref(graph, *id))
            .collect();
        let startpoint = self.node_ref(graph, target.startpoint);
        let endpoint = self.node_ref(graph, target.endpoint);
        let class = classify_path(&startpoint, target.kind);
        let output_aliases = if target.kind == EndpointKind::Register {
            aliases_for_register_bit(alias_lookup, &target.group, target.bit)
        } else {
            Vec::new()
        };
        let estimated_delay_ns = self.path_delay_ns(graph, target, node_delay, model);
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
    /// output, plus that net, plus register setup. Taken over *all* endpoints
    /// the max matches the overview figure for register-bound designs — but the
    /// `paths()` response is sorted by depth and truncated, so a slow-but-shallow
    /// path can be omitted and the max over the returned list may be lower.
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
        let nodes = node_ids
            .into_iter()
            .map(|id| {
                let node = &graph.nodes[id as usize];
                let boundary =
                    !projection.roots.contains(&id) && projection.boundary_nodes.contains(&id);
                GraphNode {
                    node: self.node_ref(graph, id),
                    is_root: projection.roots.contains(&id).then_some(true),
                    is_boundary: boundary.then_some(true),
                    depth: graph
                        .is_comb(id)
                        .then(|| self.node_depth[id as usize])
                        .flatten(),
                    params: node.params.clone(),
                    controls: node_controls(graph, id),
                    width: None,
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
            truncated: projection.truncated || edges_truncated,
        };
        let projected = if projection.show_infrastructure {
            subgraph
        } else {
            collapse_infrastructure(graph, subgraph)
        };
        cap_subgraph_edges(projected)
    }
}

fn endpoints_heap_bytes(endpoints: &EndpointsResponse) -> usize {
    let mut bytes = endpoints
        .registers
        .capacity()
        .saturating_mul(size_of::<RegisterGroup>())
        .saturating_add(
            endpoints
                .outputs
                .capacity()
                .saturating_mul(size_of::<OutputGroup>()),
        )
        .saturating_add(
            endpoints
                .inputs
                .capacity()
                .saturating_mul(size_of::<InputGroup>()),
        );
    for group in &endpoints.registers {
        bytes = bytes
            .saturating_add(group.name.capacity())
            .saturating_add(group.cell_type.capacity())
            .saturating_add(group.clock.as_ref().map_or(0, String::capacity))
            .saturating_add(group.src.as_ref().map_or(0, String::capacity))
            .saturating_add(
                group
                    .bits
                    .capacity()
                    .saturating_mul(size_of::<EndpointBit>()),
            )
            .saturating_add(
                group
                    .output_aliases
                    .capacity()
                    .saturating_mul(size_of::<OutputAlias>()),
            );
        for alias in &group.output_aliases {
            bytes = bytes.saturating_add(alias.name.capacity()).saturating_add(
                alias
                    .bits
                    .capacity()
                    .saturating_mul(size_of::<OutputAliasBit>()),
            );
        }
    }
    for group in &endpoints.outputs {
        bytes = bytes.saturating_add(group.name.capacity()).saturating_add(
            group
                .bits
                .capacity()
                .saturating_mul(size_of::<EndpointBit>()),
        );
    }
    for group in &endpoints.inputs {
        bytes = bytes
            .saturating_add(group.name.capacity())
            .saturating_add(group.bits.capacity().saturating_mul(size_of::<InputBit>()));
    }
    bytes
}

fn source_range_heap_bytes(range: &SourceRangeMapping) -> usize {
    range.file.capacity().saturating_add(
        range
            .node_ids
            .capacity()
            .saturating_mul(size_of::<NodeId>()),
    )
}

fn source_map_heap_bytes(source_map: &SourceMapResponse) -> usize {
    let mut bytes = source_map
        .files
        .capacity()
        .saturating_mul(size_of::<String>())
        .saturating_add(
            source_map
                .by_line
                .len()
                .saturating_mul(size_of::<(String, Vec<NodeId>)>() + 3 * size_of::<usize>()),
        )
        .saturating_add(
            source_map
                .ranges
                .capacity()
                .saturating_mul(size_of::<SourceRangeMapping>()),
        );
    for file in &source_map.files {
        bytes = bytes.saturating_add(file.capacity());
    }
    for (location, ids) in &source_map.by_line {
        bytes = bytes
            .saturating_add(location.capacity())
            .saturating_add(ids.capacity().saturating_mul(size_of::<NodeId>()));
    }
    for range in &source_map.ranges {
        bytes = bytes.saturating_add(source_range_heap_bytes(range));
    }
    bytes
}

fn stats_heap_bytes(stats: &Stats) -> usize {
    let mut bytes = stats
        .cells_by_type
        .len()
        .saturating_mul(size_of::<(String, usize)>() + 3 * size_of::<usize>());
    for cell_type in stats.cells_by_type.keys() {
        bytes = bytes.saturating_add(cell_type.capacity());
    }
    bytes
}

struct SubgraphProjection<'a> {
    roots: &'a HashSet<NodeId>,
    boundary_nodes: &'a HashSet<NodeId>,
    truncated: bool,
    show_infrastructure: bool,
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
    queue: VecDeque<(NodeId, u32)>,
    current: Option<TraversalFrame>,
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
pub struct ConeOptions {
    pub dir: ConeDir,
    pub max_depth: u32,
    pub max_nodes: usize,
    pub hide_control: bool,
    pub hide_const: bool,
    pub show_infrastructure: bool,
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
fn unit_id(grouping: Option<&GroupPartition>, base: u32, id: NodeId) -> u32 {
    match grouping.and_then(|partition| partition.group_of.get(&id)) {
        Some(group_id) => base + group_id,
        None => id,
    }
}

/// Collapse a per-bit subgraph into its group quotient: every group's member
/// nodes become one synthetic node, edges are re-merged across the resulting
/// unit ids, and intra-group edges vanish. Singletons pass through unchanged.
/// Runs after infrastructure collapse and edge capping, so synthetic ids are
/// never indexed back into `graph.nodes`.
fn quotient_subgraph(graph: &Graph, subgraph: Subgraph, partition: &GroupPartition) -> Subgraph {
    const MAX_MERGED_SRC_FRAGMENTS: usize = 8;
    let base = graph.nodes.len() as u32;

    struct GroupAcc {
        members: Vec<u32>,
        is_root: bool,
        is_boundary: bool,
        depth: Option<u32>,
        controls: Vec<ControlRef>,
    }

    let mut group_accs: BTreeMap<GroupId, GroupAcc> = BTreeMap::new();
    let mut nodes: Vec<GraphNode> = Vec::new();
    for node in subgraph.nodes {
        let Some(group_id) = partition.group_of.get(&node.node.id).copied() else {
            nodes.push(node);
            continue;
        };
        let acc = group_accs.entry(group_id).or_insert_with(|| GroupAcc {
            members: Vec::new(),
            is_root: false,
            is_boundary: false,
            depth: None,
            controls: Vec::new(),
        });
        acc.members.push(node.node.id);
        acc.is_root |= node.is_root == Some(true);
        acc.is_boundary |= node.is_boundary == Some(true);
        if let Some(depth) = node.depth {
            acc.depth = Some(acc.depth.map_or(depth, |current| current.max(depth)));
        }
        for control in node.controls {
            if !acc
                .controls
                .iter()
                .any(|kept| kept.role == control.role && kept.net_name == control.net_name)
            {
                acc.controls.push(control);
            }
        }
    }

    for (group_id, acc) in group_accs {
        let group = &partition.groups[group_id as usize];
        let mut members = acc.members;
        members.sort_unstable();
        let register = matches!(group.kind, GroupKind::Register);
        let mut src_fragments: Vec<String> = Vec::new();
        for member in &members {
            if let Some(src) = graph.nodes[*member as usize].src.as_deref() {
                for fragment in src.split('|') {
                    if !fragment.is_empty()
                        && !src_fragments.iter().any(|kept| kept == fragment)
                        && src_fragments.len() < MAX_MERGED_SRC_FRAGMENTS
                    {
                        src_fragments.push(fragment.to_owned());
                    }
                }
            }
        }
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
                seq: register.then_some(true),
                register: register.then(|| is_register_type(&group.cell_type)),
                src: (!src_fragments.is_empty()).then(|| src_fragments.join("|")),
            },
            is_root: is_root.then_some(true),
            is_boundary: (!is_root && acc.is_boundary).then_some(true),
            depth: acc.depth,
            params: BTreeMap::new(),
            controls: acc.controls,
            width: Some(members.len() as u32),
            members: Some(members),
        });
    }
    nodes.sort_by_key(|node| node.node.id);

    // Re-merge edges across unit ids: intra-group edges (same unit both ends)
    // vanish; parallel bus edges collapse to one carrying every bit.
    let mut merged: BTreeMap<(u32, u32, String, String), GraphEdge> = BTreeMap::new();
    for edge in subgraph.edges {
        let from = unit_id(Some(partition), base, edge.from);
        let to = unit_id(Some(partition), base, edge.to);
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
        truncated: subgraph.truncated,
    }
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
    let mut startpoint = vec![None; graph.nodes.len()];
    // Parallel delay-weighted longest path (picoseconds); see delay_model.
    let mut node_delay = vec![0.0f64; graph.nodes.len()];

    while let Some(id) = queue.pop_front() {
        let cell = graph.nodes[id as usize].cell_type.as_deref();
        let weight = cell.map(cell_depth_weight).unwrap_or(1);
        let mut best: Option<(u32, usize, NodeId)> = None;
        let mut best_delay = 0.0f64;
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
            let base_delay = if follows_depth {
                node_delay[edge.from as usize]
            } else {
                model.launch_ps(graph.nodes[edge.from as usize].seq)
            };
            let net = model.net_delay_ps(fanout_of(graph, edge.from));
            best_delay = best_delay.max(base_delay + net);
        }
        let (node_depth, pred, origin) = best.unwrap_or((weight, usize::MAX, id));
        depth[id as usize] = Some(node_depth);
        startpoint[id as usize] = Some(origin);
        node_delay[id as usize] = best_delay
            + cell
                .map(|c| model.cell_delay_ps(c))
                .unwrap_or(model.cell_ps);
        if pred != usize::MAX {
            best_pred[id as usize] = Some(pred);
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

    // Worst arrival across every combinational node, plus that node's output
    // net and the capturing register's setup — the estimated critical path.
    let estimated_max_delay_ps = graph
        .nodes
        .iter()
        .filter(|node| depth[node.id as usize].is_some())
        .map(|node| node_delay[node.id as usize] + model.net_delay_ps(fanout_of(graph, node.id)))
        .fold(None, |acc: Option<f64>, d| {
            Some(acc.map_or(d, |a| a.max(d)))
        })
        .map(|d| d + model.ff_setup_ps);

    DepthComputation {
        node_depth: depth,
        best_pred,
        node_startpoint: startpoint,
        estimated_max_delay_ps,
        node_delay,
    }
}

/// Number of sinks a node's output drives — the fanout used by the net-delay
/// estimate.
fn fanout_of(graph: &Graph, id: NodeId) -> u32 {
    graph.outgoing[id as usize].len() as u32
}

/// Recompute only the estimated worst-case combinational delay (nanoseconds) for
/// a graph under a given delay model. Used to *retune* timing on a cached design
/// without re-running synthesis. Returns `None` when there are no combinational
/// paths. Mirrors the estimate produced during [`Analysis::with_delay_model`].
pub fn estimate_delay_ns(graph: &Graph, model: &DelayModel) -> Option<f64> {
    let loop_set: HashSet<NodeId> = find_comb_loops(graph).into_iter().collect();
    compute_depths(graph, &loop_set, model)
        .estimated_max_delay_ps
        .map(|ps| ps / 1000.0)
}

fn is_addressable_sequential_node(graph: &Graph, id: NodeId) -> bool {
    graph.nodes.get(id as usize).is_some_and(|node| {
        node.cell_type
            .as_deref()
            .is_some_and(is_addressable_sequential_type)
    })
}

fn is_depth_node(graph: &Graph, id: NodeId) -> bool {
    graph.is_comb(id) || is_addressable_sequential_node(graph, id)
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
) -> (EndpointsResponse, Vec<EndpointTarget>) {
    let design_files: HashSet<&str> = source_files.iter().map(String::as_str).collect();
    let mut targets = Vec::new();
    let mut register_map: BTreeMap<String, RegisterGroup> = BTreeMap::new();
    let mut register_bits: HashMap<(NodeId, Option<u32>), (String, usize)> = HashMap::new();

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
        for edge_idx in &graph.incoming[node.id as usize] {
            let edge = &graph.edges[*edge_idx];
            if !edge.control
                && (!is_addressable_sequential_node(graph, node.id)
                    || !is_depth_input_edge(graph, edge))
            {
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
                    depth: edge_depth(graph, node_depth, *edge_idx),
                    group: node.name.clone(),
                    kind: EndpointKind::Blackbox,
                    bit: 0,
                });
            }
        }
    }

    (
        EndpointsResponse {
            registers: register_map.into_values().collect(),
            outputs,
            inputs,
        },
        targets,
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
    match pin.to_ascii_uppercase().as_str() {
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

fn node_controls(graph: &Graph, node_id: NodeId) -> Vec<ControlRef> {
    let mut controls = Vec::new();
    for edge_idx in &graph.incoming[node_id as usize] {
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
    controls
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
) -> bool {
    let edges = match dir {
        ConeDir::Fanin => &graph.incoming[id as usize],
        ConeDir::Fanout => &graph.outgoing[id as usize],
    };
    edges
        .iter()
        .any(|idx| !should_hide_edge(graph, &graph.edges[*idx], hide_control, hide_const))
}

fn merge_edges(edges: Vec<&Edge>) -> (Vec<GraphEdge>, bool) {
    let mut merged: BTreeMap<(NodeId, NodeId, String, String), GraphEdge> = BTreeMap::new();
    let mut truncated = false;
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
            entry.bits.push(bit);
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
    subgraph
}

fn build_stats(
    graph: &Graph,
    endpoints: &EndpointsResponse,
    endpoint_targets: &[EndpointTarget],
    estimated_max_delay_ps: Option<f64>,
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
    let max_depth = endpoint_targets
        .iter()
        .map(|target| target.depth)
        .max()
        .unwrap_or_default();
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

fn insert_bounded_node(ids: &mut BTreeSet<NodeId>, id: NodeId) -> bool {
    ids.insert(id);
    ids.len() >= SOURCE_ROOT_COLLECTION_CAP
}

fn format_source_range(range: &SourceRangeMapping) -> String {
    format!("{}:{}-{}", range.file, range.start_line, range.end_line)
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

fn parse_src_loc(loc: &str) -> Option<(String, usize, usize)> {
    let trimmed = loc.trim();
    let (file, rest) = trimmed.rsplit_once(':')?;
    let (start, end) = rest.split_once('-').map_or((rest, rest), |(a, b)| (a, b));
    let start_line: usize = start.split('.').next()?.parse().ok()?;
    let end_line: usize = end.split('.').next()?.parse().ok()?;
    let file_name = std::path::Path::new(file)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file)
        .to_owned();
    Some((file_name, start_line, end_line.max(start_line)))
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
    if let Some(name) = info
        .q_bits
        .iter()
        .find_map(|bit| bit.net())
        .and_then(|net| register_q_name(graph, net))
        .filter(|name| !is_hidden_name(name))
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
    if let Some(port) = forwarded_output_port(graph, node.id) {
        return port;
    }
    if !is_hidden_name(&node.name) {
        return node.name.clone();
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

    fn fixture(name: &str) -> (Graph, Analysis) {
        let json = std::fs::read_to_string(format!("tests/fixtures/{name}")).unwrap();
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
        let (_graph, analysis) = fixture("and_chain_rtl.json");
        let est = analysis
            .stats
            .estimated_delay_ns
            .expect("a combinational design has a delay estimate");
        // A depth-3 chain: a few cells + fanout nets + capture setup — the rough
        // pre-route figure should be positive and in a sane nanosecond range.
        assert!(est > 0.3 && est < 30.0, "implausible estimate: {est} ns");
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
        let s7 = analysis.paths_with_model(&graph, &DelayModel::series7(), 25, None);
        let usp = analysis.paths_with_model(&graph, &DelayModel::ultrascale_plus(), 25, None);
        // A faster model shrinks the per-path delays without changing structure.
        assert_eq!(s7.paths.len(), usp.paths.len());
        assert!(worst(&usp) < worst(&s7), "ultrascale+ should be faster");
    }

    #[test]
    fn estimate_delay_ns_shrinks_with_a_faster_preset() {
        let (graph, _analysis) = fixture("and_chain_rtl.json");
        let s7 = estimate_delay_ns(&graph, &DelayModel::series7()).unwrap();
        let usp = estimate_delay_ns(&graph, &DelayModel::ultrascale_plus()).unwrap();
        let s7_fast = estimate_delay_ns(&graph, &DelayModel::series7().scaled(0.78)).unwrap();
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
                bit: Some(bit),
                net_name: "wide_bus".to_owned(),
                control: false,
            })
            .collect();
        let started = Instant::now();
        let (merged, truncated) = merge_edges(edges.iter().collect());

        assert!(started.elapsed().as_secs() < 5);
        assert!(!truncated);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].bits.len(), width as usize);
        assert_eq!(merged[0].bits.first(), Some(&0));
        assert_eq!(merged[0].bits.last(), Some(&(width - 1)));
    }

    #[test]
    fn dense_subgraphs_enforce_the_merged_edge_cap_deterministically() {
        let graph = dense_dag_graph(150);
        let analysis = Analysis::new(&graph, vec!["dense.sv".to_owned()]);

        let first = analysis.full_netlist(&graph, MAX_SUBGRAPH_NODES, true, true, false, None);
        let second = analysis.full_netlist(&graph, MAX_SUBGRAPH_NODES, true, true, false, None);

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

        let controls_visible =
            analysis.full_netlist(&graph, MAX_SUBGRAPH_NODES, true, false, false, None);
        assert_eq!(controls_visible.edges.len(), MAX_SUBGRAPH_EDGES);
        assert!(controls_visible.truncated);

        let controls_hidden =
            analysis.full_netlist(&graph, MAX_SUBGRAPH_NODES, true, true, false, None);
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
    }

    #[test]
    fn source_range_roots_use_a_sentinel_and_propagate_truncation() {
        let graph = sourced_node_graph(SOURCE_ROOT_COLLECTION_CAP + 500);
        let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
        let roots = analysis
            .source_nodes_range(&graph, "source.sv", 1, 1)
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
                },
                None,
            )
            .unwrap();
        assert_eq!(envelope.nodes.len(), 400);
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
            end_line: 1_000_003,
            node_ids: vec![0],
            mapping_incomplete: false,
        };
        let mut analysis = Analysis::new(&graph, vec!["sparse.sv".to_owned()]);
        analysis.extend_source_ranges(vec![range.clone()], false);
        analysis.set_source_probe_hints(vec![SourceProbeHint {
            file: "sparse.sv".to_owned(),
            start_line: 2,
            end_line: 1_000_003,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Signal,
        }]);

        assert_eq!(
            analysis.source_nodes_range(&graph, "sparse.sv", 500_000, 500_000),
            Some(vec![0])
        );
        let probe = analysis
            .source_probe_range(&graph, "sparse.sv", 500_000, 500_000)
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
                node_ids: Vec::new(),
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
