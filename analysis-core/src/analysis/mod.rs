//! Bounded structural analysis and API response projections.

mod api;
mod controls;
mod depth;
mod endpoints;
mod projection;
mod stats;

pub use api::*;
pub use depth::node_ref;

use controls::*;
use depth::{
    DepthComputation, compute_depths, fanout_of, find_comb_loops, is_addressable_sequential_node,
    is_depth_input_edge, is_depth_node, is_depth_output_edge,
};
use endpoints::*;
use projection::*;
use stats::*;

use crate::delay_model::DelayModel;
use crate::graph::{
    Edge, Graph, NodeId, NodeKind, is_infrastructure_cell, is_register_type,
    is_transparent_data_buffer,
};
use crate::grouping::{GroupId, GroupKind, GroupPartition, GroupingProjection};
use crate::netlist::PortDirection;
use crate::source::{
    SourceBitRangesResponse, SourceMapResponse, SourceProbeDirection, SourceProvenanceIndex,
    SourceSelectionRange,
};
#[cfg(test)]
use crate::source::{SourceProbeHint, SourceRangeMapping};
use deepsize::DeepSizeOf;
use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

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
#[cfg(test)]
mod tests;
