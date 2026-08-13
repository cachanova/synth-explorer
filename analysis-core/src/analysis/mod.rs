//! Bounded structural analysis and API response projections.

mod api;
mod controls;
mod depth;
mod endpoints;
mod paths;
mod projection;
mod stats;

pub use api::*;

use controls::pure_hidden_control_ports;
use depth::{DepthComputation, compute_depths, find_comb_loops};
use endpoints::{EndpointTarget, discover_endpoints, is_direct_endpoint};
use stats::{build_stats, build_warnings};

use crate::delay_model::DelayModel;
use crate::graph::{Graph, NodeId, NodeKind};
use crate::grouping::{GroupPartition, GroupingProjection};
use crate::source::{
    SourceBitRangesResponse, SourceMapResponse, SourceProbeDirection, SourceProvenanceIndex,
    SourceSelectionRange,
};
#[cfg(test)]
use crate::source::{SourceProbeHint, SourceRangeMapping};
use deepsize::DeepSizeOf;
use std::cmp::Reverse;
use std::collections::{BTreeSet, HashMap, HashSet};

const PATH_NODE_CAP: usize = 512;
const PATH_RECONSTRUCTION_NODE_BUDGET: usize = 65_536;
pub const MAX_PATH_RESULTS: usize = 8_000;
pub const MAX_SUBGRAPH_NODES: usize = 2_000;
/// A deliberate group expansion can be wider than an ordinary cone. This
/// accommodates the 2,048-instance inferred-memory regression plus context.
pub const MAX_GROUP_EXPANSION_NODES: usize = 4_096;
const MAX_FULL_GROUP_MEMBERS: usize = 256;
pub(crate) const MAX_SUBGRAPH_EDGES: usize = 10_000;
const MAX_SUBGRAPH_EDGE_BITS: usize = MAX_SUBGRAPH_EDGES;
const MAX_FULL_NETLIST_EDGE_VISITS: usize = MAX_SUBGRAPH_EDGES * 4;
const MAX_GROUP_EXPANSION_EDGE_VISITS: usize = MAX_SUBGRAPH_EDGES * 4;
const MAX_BOUNDARY_ENDPOINTS: usize = 10_000;
const MAX_BOUNDARY_ENDPOINT_BITS: usize = 100_000;
const FULL_NETLIST_CONTEXT_NODE_BUDGET: usize = MAX_SUBGRAPH_NODES * 16;
const _: () = assert!(crate::source::SOURCE_ROOT_COLLECTION_CAP == MAX_SUBGRAPH_NODES + 1);
const SOURCE_BIDIRECTIONAL_DEPTH: u32 = 1;

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

    /// Public for the provenance workload in `benches/provenance.rs`.
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

    /// Public for the provenance workload in `benches/provenance.rs`.
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

    /// Public for the provenance workload in `benches/provenance.rs`.
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
}
#[cfg(test)]
mod tests;
